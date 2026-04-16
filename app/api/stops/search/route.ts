export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { searchStations, getStationboardTrams } from '@/lib/transport'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim()

  if (!q || q.length < 2) {
    return NextResponse.json({ error: 'q must be at least 2 characters' }, { status: 400 })
  }

  try {
    // 1. Find stations via transport.opendata.ch (no GTFS required)
    const stations = await searchStations(q)

    if (stations.length === 0) {
      return NextResponse.json({ results: [], count: 0, query: q })
    }

    // 2. For each station (≤6) call stationboard in parallel to discover tram lines
    const enriched = await Promise.all(
      stations.slice(0, 6).map(async station => {
        const trams = await getStationboardTrams(station.id, 12)
        const lines      = Array.from(new Set(trams.map(t => t.line).filter(Boolean)))
        const directions = Array.from(new Set(trams.map(t => t.direction).filter(Boolean)))
        return { ...station, lines, directions, is_tram_stop: trams.length > 0 }
      })
    )

    // 3. Check which of these IDs are already active in the DB (non-fatal if table missing)
    const allIds = enriched.map(s => s.id)
    let activeIds = new Set<string>()
    try {
      const activeRows = await sql`
        SELECT stop_id FROM tram_stops_config
        WHERE stop_id = ANY(${allIds}) AND active = TRUE
      `
      activeIds = new Set(activeRows.map(r => String(r.stop_id)))
    } catch { /* table may not exist yet — proceed without active status */ }

    // 4. Group by stop_name (multiple IDs can share a name = different sides of road)
    const grouped = new Map<string, typeof enriched>()
    for (const s of enriched) {
      if (!grouped.has(s.name)) grouped.set(s.name, [])
      grouped.get(s.name)!.push(s)
    }

    const results = Array.from(grouped.entries()).map(([stop_name, stops]) => {
      const allLines = Array.from(new Set(stops.flatMap(s => s.lines))).join(', ')
      return {
        stop_name,
        line: allLines || '?',
        platforms: stops.map(s => ({
          stop_id:      s.id,
          stop_name:    s.name,
          line:         s.lines.join(', '),
          direction_id: null as null,
          // headsign = summary of where trams go from this platform
          headsign:     s.directions.slice(0, 3).join(' / ') || null,
          platform:     null as null,
          active:       activeIds.has(s.id),
        })),
      }
    })

    return NextResponse.json({ results, count: results.length, query: q, source: 'transport.opendata.ch' })
  } catch (err) {
    console.error('Stops search error:', err)
    return NextResponse.json({ error: 'Search failed', detail: String(err) }, { status: 503 })
  }
}
