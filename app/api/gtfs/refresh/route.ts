export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { parseCsv, VBZ_CKAN_API_URL, isTramRoute } from '@/lib/gtfs'
import { unzipSync } from 'fflate'

// GET — called by Vercel cron or the Settings UI (no auth; GTFS data is public).
export async function GET() {
  return runRefresh()
}

// POST — called from Pi or external tooling; requires INGEST_SECRET.
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (process.env.INGEST_SECRET && apiKey !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runRefresh()
}

// ── Lean byte-level parser for stop_times.txt ─────────────────────────────────
// Calling parseCsv() on stop_times.txt creates one JS object per row (millions
// of rows for VBZ), which exhausts the 2 GB Vercel memory limit. Instead we
// scan raw bytes, extract only trip_id and stop_id, and build a Map<stop_id, info>.
function buildTramStopMap(
  rawBytes: Uint8Array,
  tramTripIds: Set<string>,
  tripInfoMap: Map<string, { line: string; headsign: string; direction_id: number }>
): Map<string, { line: string; headsign: string; direction_id: number }[]> {
  const stopServiceMap = new Map<string, { line: string; headsign: string; direction_id: number }[]>()
  const decoder = new TextDecoder('utf-8')
  let tripIdIdx = -1
  let stopIdIdx = -1
  let headerParsed = false
  let lineStart = 0

  for (let i = 0; i <= rawBytes.length; i++) {
    if (i === rawBytes.length || rawBytes[i] === 10 /* '\n' */) {
      let lineEnd = i
      // Strip trailing \r for CRLF files
      if (lineEnd > lineStart && rawBytes[lineEnd - 1] === 13) lineEnd--

      if (lineEnd > lineStart) {
        // Decode only this one line — subarray is a zero-copy view
        const line = decoder.decode(rawBytes.subarray(lineStart, lineEnd))

        if (!headerParsed) {
          const cols = line.split(',')
          tripIdIdx = cols.indexOf('trip_id')
          stopIdIdx = cols.indexOf('stop_id')
          headerParsed = true
        } else if (tripIdIdx >= 0 && stopIdIdx >= 0) {
          const cols = line.split(',')
          const tripId = cols[tripIdIdx]
          const stopId = cols[stopIdIdx]
          if (tripId && stopId && tramTripIds.has(tripId)) {
            const info = tripInfoMap.get(tripId)
            if (info) {
              if (!stopServiceMap.has(stopId)) stopServiceMap.set(stopId, [])
              const existing = stopServiceMap.get(stopId)!
              if (!existing.some(e => e.line === info.line && e.direction_id === info.direction_id)) {
                existing.push(info)
              }
            }
          }
        }
      }
      lineStart = i + 1
    }
  }

  return stopServiceMap
}

async function runRefresh(): Promise<NextResponse> {
  try {
    // ── 1. Discover the current GTFS ZIP URL via the CKAN API ─────────────────
    const ckanRes = await fetch(VBZ_CKAN_API_URL, {
      headers: { 'User-Agent': 'TramWatch/1.0' },
    })
    if (!ckanRes.ok) {
      return NextResponse.json(
        { error: `CKAN API error: ${ckanRes.status} ${ckanRes.statusText}` },
        { status: 502 }
      )
    }
    const ckanData = await ckanRes.json() as {
      success: boolean
      result: { resources: Array<{ url: string; format: string; name: string }> }
    }
    if (!ckanData.success || !ckanData.result?.resources?.length) {
      return NextResponse.json({ error: 'CKAN API returned no resources' }, { status: 502 })
    }
    const zipResource = ckanData.result.resources.find(
      r => r.url.toLowerCase().endsWith('.zip') || r.format.toUpperCase() === 'ZIP'
    )
    if (!zipResource) {
      return NextResponse.json(
        { error: 'No ZIP resource found in CKAN package', resources: ckanData.result.resources.map(r => r.url) },
        { status: 422 }
      )
    }
    const gtfsZipUrl = zipResource.url

    // ── 2. Fetch and unzip ────────────────────────────────────────────────────
    const response = await fetch(gtfsZipUrl, {
      headers: { 'User-Agent': 'TramWatch/1.0' },
    })
    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch GTFS ZIP: ${response.status} ${response.statusText}`, url: gtfsZipUrl },
        { status: 502 }
      )
    }

    const zipBuffer = new Uint8Array(await response.arrayBuffer())
    const files = unzipSync(zipBuffer)

    // Helper: decode small files to string (safe for routes/trips/stops/calendar)
    const getFileCsv = (name: string): string | null => {
      const entry = files[name]
      return entry ? new TextDecoder('utf-8').decode(entry) : null
    }

    const routesCsv   = getFileCsv('routes.txt')
    const stopsCsv    = getFileCsv('stops.txt')
    const tripsCsv    = getFileCsv('trips.txt')
    const calendarCsv = getFileCsv('calendar.txt')
    const feedInfoCsv = getFileCsv('feed_info.txt')
    // stop_times.txt stays as Uint8Array — decoded per-line in buildTramStopMap
    const stopTimesRaw = files['stop_times.txt'] ?? null

    if (!routesCsv || !stopsCsv || !tripsCsv) {
      return NextResponse.json({ error: 'Required GTFS files not found in ZIP' }, { status: 422 })
    }

    // ── 3. Parse tram routes (route_type 0 standard, 900 Swiss extended) ──────
    const routes = parseCsv(routesCsv)
    const tramRouteMap = new Map<string, string>() // route_id → route_short_name
    for (const r of routes) {
      if (isTramRoute(parseInt(r.route_type ?? '999', 10))) {
        tramRouteMap.set(r.route_id, r.route_short_name ?? '')
      }
    }

    // ── 4. Build trip_id → { line, headsign, direction_id } ──────────────────
    const trips = parseCsv(tripsCsv)
    const tripInfoMap = new Map<string, { line: string; headsign: string; direction_id: number }>()
    const tramTripIds = new Set<string>()
    for (const t of trips) {
      if (!tramRouteMap.has(t.route_id)) continue
      const info = {
        line: tramRouteMap.get(t.route_id)!,
        headsign: t.trip_headsign ?? '',
        direction_id: parseInt(t.direction_id ?? '0', 10),
      }
      tripInfoMap.set(t.trip_id, info)
      tramTripIds.add(t.trip_id)
    }

    // ── 5. Build stop → service map using lean byte parser ────────────────────
    const stopServiceMap = stopTimesRaw
      ? buildTramStopMap(stopTimesRaw, tramTripIds, tripInfoMap)
      : new Map<string, { line: string; headsign: string; direction_id: number }[]>()

    // ── 6. Upsert all tram-served stops ───────────────────────────────────────
    const stops = parseCsv(stopsCsv)
    const tramStops = stops.filter(s => stopServiceMap.has(s.stop_id))

    let upsertedCount = 0
    for (const stop of tramStops) {
      const services = stopServiceMap.get(stop.stop_id)!
      const primary = services[0]
      await sql`
        INSERT INTO tram_stops_config (stop_id, stop_name, line, direction_id, headsign, active)
        VALUES (
          ${stop.stop_id},
          ${stop.stop_name},
          ${primary.line},
          ${primary.direction_id},
          ${primary.headsign},
          FALSE
        )
        ON CONFLICT (stop_id) DO UPDATE SET
          stop_name    = EXCLUDED.stop_name,
          line         = EXCLUDED.line,
          direction_id = EXCLUDED.direction_id,
          headsign     = EXCLUDED.headsign
      `
      upsertedCount++
    }

    // ── 7. Log to gtfs_meta ───────────────────────────────────────────────────
    let validFrom: string | null = null
    let validTo:   string | null = null
    let feedVersion: string | null = null

    if (calendarCsv) {
      const calendar = parseCsv(calendarCsv)
      const starts = calendar.map(r => r.start_date).filter(Boolean).sort()
      const ends   = calendar.map(r => r.end_date).filter(Boolean).sort()
      const fmt = (d: string) => `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`
      validFrom = starts[0] ? fmt(starts[0]) : null
      validTo   = ends[ends.length - 1] ? fmt(ends[ends.length - 1]) : null
    }

    if (feedInfoCsv) {
      feedVersion = parseCsv(feedInfoCsv)[0]?.feed_version ?? null
    }

    await sql`
      INSERT INTO gtfs_meta (feed_version, valid_from, valid_to)
      VALUES (${feedVersion}, ${validFrom}, ${validTo})
    `

    return NextResponse.json({
      success: true,
      tram_routes: tramRouteMap.size,
      tram_stops_upserted: upsertedCount,
      feed_version: feedVersion,
      valid_from: validFrom,
      valid_to: validTo,
      gtfs_url: gtfsZipUrl,
    })
  } catch (err) {
    console.error('GTFS refresh error:', err)
    return NextResponse.json({ error: 'GTFS refresh failed', detail: String(err) }, { status: 500 })
  }
}
