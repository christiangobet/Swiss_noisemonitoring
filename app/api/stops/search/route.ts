export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim()

  if (!q || q.length < 2) {
    return NextResponse.json({ error: 'q must be at least 2 characters' }, { status: 400 })
  }

  try {
    // Search saved stops first
    const saved = await sql`
      SELECT id, stop_id, stop_name, line, direction_id, headsign, platform, active
      FROM tram_stops_config
      WHERE stop_name ILIKE ${'%' + q + '%'}
      ORDER BY stop_name
      LIMIT 50
    `

    // Group by physical platform (stop_name + line combination)
    const grouped: Record<string, typeof saved> = {}
    for (const stop of saved) {
      const key = `${stop.stop_name as string}__${stop.line as string}`
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(stop)
    }

    const results = Object.entries(grouped).map(([, stops]) => ({
      stop_name: stops[0].stop_name,
      line: stops[0].line,
      platforms: stops.map(s => ({
        stop_id: s.stop_id,
        stop_name: s.stop_name,
        line: s.line,
        direction_id: s.direction_id,
        headsign: s.headsign,
        platform: s.platform,
        active: s.active,
      })),
    }))

    return NextResponse.json({ results, count: results.length, query: q })
  } catch (err) {
    console.error('Stops search error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
