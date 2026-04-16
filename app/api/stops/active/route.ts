export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export async function GET() {
  try {
    const rows = await sql`
      SELECT stop_id, stop_name, line, direction_id, headsign, platform, active
      FROM tram_stops_config
      WHERE active = TRUE
      ORDER BY stop_name, line, direction_id
    `

    // Group by stop_name+line (same shape as search results)
    const grouped = new Map<string, typeof rows>()
    for (const row of rows) {
      const key = `${row.stop_name as string}||${row.line as string}`
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(row)
    }

    const stops = Array.from(grouped.entries()).map(([key, platforms]) => {
      const [stop_name] = key.split('||')
      return {
        stop_name,
        line: platforms[0].line as string,
        platforms: platforms.map(p => ({
          stop_id:      p.stop_id,
          stop_name:    p.stop_name,
          line:         p.line,
          direction_id: p.direction_id,
          headsign:     p.headsign,
          platform:     p.platform,
          active:       p.active,
        })),
      }
    })

    // Derive the monitored stop name (the common stop_name across all active platforms)
    const stopNames = new Set(stops.map(s => s.stop_name))
    const monitoredStop = stopNames.size === 1 ? Array.from(stopNames)[0] : null

    return NextResponse.json({
      stops,
      count: stops.reduce((n, s) => n + s.platforms.length, 0),
      monitored_stop: monitoredStop,
    })
  } catch (err) {
    console.error('stops/active error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
