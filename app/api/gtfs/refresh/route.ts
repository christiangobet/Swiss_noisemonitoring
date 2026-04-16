export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { parseCsv, VBZ_CKAN_API_URL, isTramRoute } from '@/lib/gtfs'
import { unzipSync } from 'fflate'

// GET — called by Vercel cron (x-vercel-cron header) or the Settings UI (no auth needed;
// GTFS data is public and the operation is read-only / idempotent).
export async function GET() {
  return runRefresh()
}

// POST — called from Pi side or external tooling; requires INGEST_SECRET.
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (process.env.INGEST_SECRET && apiKey !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runRefresh()
}

async function runRefresh(): Promise<NextResponse> {
  try {
    // ── 1. Discover the current GTFS ZIP URL via the CKAN API ────────────────
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
    // Pick the first ZIP resource (there is typically exactly one)
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

    // ── 2. Fetch and unzip the VBZ GTFS feed ────────────────────────────────
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

    const getFile = (name: string): string | null => {
      const entry = files[name]
      return entry ? new TextDecoder('utf-8').decode(entry) : null
    }

    const routesCsv   = getFile('routes.txt')
    const stopsCsv    = getFile('stops.txt')
    const tripsCsv    = getFile('trips.txt')
    const stopTimesCsv = getFile('stop_times.txt')
    const calendarCsv = getFile('calendar.txt')
    const feedInfoCsv = getFile('feed_info.txt')

    if (!routesCsv || !stopsCsv || !tripsCsv) {
      return NextResponse.json({ error: 'Required GTFS files not found in ZIP' }, { status: 422 })
    }

    // ── 2. Parse tram routes (route_type = 0) ───────────────────────────────
    const routes = parseCsv(routesCsv)
    const tramRouteMap = new Map<string, string>() // route_id → route_short_name
    for (const r of routes) {
      if (isTramRoute(parseInt(r.route_type ?? '999', 10))) {
        tramRouteMap.set(r.route_id, r.route_short_name ?? '')
      }
    }

    // ── 3. Build trip_id → { line, headsign, direction_id } ─────────────────
    const trips = parseCsv(tripsCsv)
    const tripInfoMap = new Map<string, { line: string; headsign: string; direction_id: number }>()
    for (const t of trips) {
      if (!tramRouteMap.has(t.route_id)) continue
      tripInfoMap.set(t.trip_id, {
        line: tramRouteMap.get(t.route_id)!,
        headsign: t.trip_headsign ?? '',
        direction_id: parseInt(t.direction_id ?? '0', 10),
      })
    }

    // ── 4. Build stop_id → Set of { line, headsign, direction_id } ──────────
    //    (one stop can be served by multiple lines/directions)
    const stopServiceMap = new Map<string, { line: string; headsign: string; direction_id: number }[]>()

    if (stopTimesCsv) {
      const stopTimes = parseCsv(stopTimesCsv)
      for (const st of stopTimes) {
        const info = tripInfoMap.get(st.trip_id)
        if (!info) continue
        if (!stopServiceMap.has(st.stop_id)) stopServiceMap.set(st.stop_id, [])
        const existing = stopServiceMap.get(st.stop_id)!
        if (!existing.some(e => e.line === info.line && e.direction_id === info.direction_id)) {
          existing.push(info)
        }
      }
    }

    // ── 5. Parse stops and upsert ALL tram-served stops ─────────────────────
    const stops = parseCsv(stopsCsv)
    const tramStops = stops.filter(s => stopServiceMap.has(s.stop_id))

    let upsertedCount = 0
    for (const stop of tramStops) {
      const services = stopServiceMap.get(stop.stop_id)!
      // Insert one row per line+direction combination, or just the primary one
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

    // ── 6. Parse feed validity and log to gtfs_meta ──────────────────────────
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
    })
  } catch (err) {
    console.error('GTFS refresh error:', err)
    return NextResponse.json({ error: 'GTFS refresh failed', detail: String(err) }, { status: 500 })
  }
}
