export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { getStationboardTrams } from '@/lib/transport'

export async function GET(req: NextRequest) {
  const debug = req.nextUrl.searchParams.has('debug')

  try {
    const activeStops = await sql`
      SELECT stop_id, monitored_lines
      FROM tram_stops_config
      WHERE active = TRUE
    `

    if (activeStops.length === 0) {
      return NextResponse.json({ departures: [], count: 0, message: 'No active stops configured' })
    }

    const stopIds = activeStops.map(s => String(s.stop_id))

    const perStop = await Promise.all(
      activeStops.map(async stop => {
        const stopId = String(stop.stop_id)
        const allDeps = await getStationboardTrams(stopId, 20, false)
        const monitoredLines = stop.monitored_lines ? String(stop.monitored_lines) : null
        if (monitoredLines && monitoredLines.trim().length > 0) {
          const allowed = new Set(monitoredLines.split(',').map((l: string) => l.trim()).filter(Boolean))
          return allDeps.filter(d => allowed.has(d.line))
        }
        return allDeps
      })
    )

    const departures = perStop.flat().sort(
      (a, b) => new Date(a.expected).getTime() - new Date(b.expected).getTime()
    )

    if (debug) {
      // Raw stationboard per stop for diagnostics
      const raw = await Promise.all(
        stopIds.map(async id => {
          const rows = await getStationboardTrams(id, 5, false)
          return { stop_id: id, count: rows.length, sample: rows.slice(0, 3) }
        })
      )
      return NextResponse.json({ departures, count: departures.length, debug: { stop_ids: stopIds, per_stop: raw } })
    }

    return NextResponse.json({ departures, count: departures.length })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return NextResponse.json({ departures: [], count: 0 })
    }
    console.error('tram-schedule error:', err)
    return NextResponse.json({ error: 'Failed to fetch tram schedule', detail: String(err) }, { status: 503 })
  }
}
