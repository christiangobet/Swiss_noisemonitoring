export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { parseCsv, VBZ_GTFS_URL, isTramRoute } from '@/lib/gtfs'

// JSZip-free approach: use built-in DecompressionStream or fetch individual files.
// We use the unzip-stream approach via a streaming fetch + manual ZIP parsing.
// For Vercel edge/serverless, we use the fflate library (bundled with Next.js).
// Since we can't import fflate directly without adding it as a dep, we use
// the native approach: fetch the ZIP and parse it server-side with Node.js zlib.

export async function GET(req: NextRequest) {
  // Allow Vercel cron (no auth) or manual call with INGEST_SECRET
  const authHeader = req.headers.get('authorization') ?? req.headers.get('x-api-key')
  const isCron = req.headers.get('x-vercel-cron') === '1'

  if (!isCron && authHeader !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return runRefresh()
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key')
  if (apiKey !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runRefresh()
}

async function runRefresh(): Promise<NextResponse> {
  try {
    // Fetch the ZIP
    const response = await fetch(VBZ_GTFS_URL, {
      headers: { 'User-Agent': 'TramWatch/1.0' },
    })

    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch GTFS ZIP: ${response.status} ${response.statusText}` },
        { status: 502 }
      )
    }

    const arrayBuffer = await response.arrayBuffer()
    const zipBuffer = Buffer.from(arrayBuffer)

    // Parse ZIP using fflate (bundled via next.js webpack)
    // We use a dynamic import to avoid SSR issues
    const { unzipSync } = await import('fflate')
    const files = unzipSync(new Uint8Array(zipBuffer))

    const getFile = (name: string): string | null => {
      const entry = files[name]
      if (!entry) return null
      return new TextDecoder('utf-8').decode(entry)
    }

    const routesCsv = getFile('routes.txt')
    const stopsCsv = getFile('stops.txt')
    const tripsCsv = getFile('trips.txt')
    const calendarCsv = getFile('calendar.txt')
    const feedInfoCsv = getFile('feed_info.txt')

    if (!routesCsv || !stopsCsv || !tripsCsv) {
      return NextResponse.json({ error: 'Required GTFS files not found in ZIP' }, { status: 422 })
    }

    // Parse routes — tram only (route_type = 0)
    const routes = parseCsv(routesCsv)
    const tramRouteIds = new Set(
      routes
        .filter(r => isTramRoute(parseInt(r.route_type ?? '999', 10)))
        .map(r => r.route_id)
    )

    // Parse trips for tram routes
    const trips = parseCsv(tripsCsv)
    const tramTrips = trips.filter(t => tramRouteIds.has(t.route_id))

    // Build stop → route/headsign/direction mapping
    const stopTimesCsv = getFile('stop_times.txt')
    const stopTripMap: Map<string, { route_id: string; headsign: string; direction_id: number; route_short_name: string }[]> = new Map()

    // Build trip_id → route info
    const tripRouteMap = new Map<string, { route_id: string; headsign: string; direction_id: number; route_short_name: string }>()
    for (const trip of tramTrips) {
      const route = routes.find(r => r.route_id === trip.route_id)
      tripRouteMap.set(trip.trip_id, {
        route_id: trip.route_id,
        headsign: trip.trip_headsign ?? '',
        direction_id: parseInt(trip.direction_id ?? '0', 10),
        route_short_name: route?.route_short_name ?? '',
      })
    }

    if (stopTimesCsv) {
      const stopTimes = parseCsv(stopTimesCsv)
      for (const st of stopTimes) {
        const tripInfo = tripRouteMap.get(st.trip_id)
        if (!tripInfo) continue
        if (!stopTripMap.has(st.stop_id)) stopTripMap.set(st.stop_id, [])
        const existing = stopTripMap.get(st.stop_id)!
        if (!existing.some(e => e.route_id === tripInfo.route_id && e.direction_id === tripInfo.direction_id)) {
          existing.push(tripInfo)
        }
      }
    }

    // Parse stops
    const stops = parseCsv(stopsCsv)

    // Find active stop_ids in our config and update their metadata
    const activeStops = await sql`SELECT stop_id FROM tram_stops_config`
    const activeStopIds = new Set(activeStops.map(s => s.stop_id as string))

    let updatedCount = 0
    for (const stop of stops) {
      if (!activeStopIds.has(stop.stop_id)) continue
      const tripInfos = stopTripMap.get(stop.stop_id) ?? []
      const primary = tripInfos[0]

      await sql`
        UPDATE tram_stops_config
        SET
          stop_name = ${stop.stop_name},
          line = ${primary?.route_short_name ?? 'unknown'},
          direction_id = ${primary?.direction_id ?? null},
          headsign = ${primary?.headsign ?? null}
        WHERE stop_id = ${stop.stop_id}
      `
      updatedCount++
    }

    // Parse calendar for validity window
    let validFrom: string | null = null
    let validTo: string | null = null
    let feedVersion: string | null = null

    if (calendarCsv) {
      const calendar = parseCsv(calendarCsv)
      const dates = calendar.map(r => r.start_date).filter(Boolean).sort()
      const endDates = calendar.map(r => r.end_date).filter(Boolean).sort()
      validFrom = dates[0] ? `${dates[0].substring(0, 4)}-${dates[0].substring(4, 6)}-${dates[0].substring(6, 8)}` : null
      validTo = endDates[endDates.length - 1] ? `${endDates[endDates.length - 1].substring(0, 4)}-${endDates[endDates.length - 1].substring(4, 6)}-${endDates[endDates.length - 1].substring(6, 8)}` : null
    }

    if (feedInfoCsv) {
      const feedInfo = parseCsv(feedInfoCsv)
      feedVersion = feedInfo[0]?.feed_version ?? null
    }

    await sql`
      INSERT INTO gtfs_meta (feed_version, valid_from, valid_to)
      VALUES (${feedVersion}, ${validFrom}, ${validTo})
    `

    return NextResponse.json({
      success: true,
      tram_routes: tramRouteIds.size,
      stops_updated: updatedCount,
      feed_version: feedVersion,
      valid_from: validFrom,
      valid_to: validTo,
    })
  } catch (err) {
    console.error('GTFS refresh error:', err)
    return NextResponse.json({ error: 'GTFS refresh failed', detail: String(err) }, { status: 500 })
  }
}
