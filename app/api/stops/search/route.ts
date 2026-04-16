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
    // Search all tram stops loaded from GTFS (active or not)
    const rows = await sql`
      SELECT stop_id, stop_name, line, direction_id, headsign, platform, active
      FROM tram_stops_config
      WHERE stop_name ILIKE ${'%' + q + '%'}
      ORDER BY stop_name, line, direction_id
      LIMIT 100
    `

    // Group by stop_name so the UI can show platforms together
    const grouped = new Map<string, typeof rows>()
    for (const row of rows) {
      const key = row.stop_name as string
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(row)
    }

    const results = Array.from(grouped.entries()).map(([stop_name, platforms]) => ({
      stop_name,
      platforms: platforms.map(p => ({
        stop_id:     p.stop_id,
        stop_name:   p.stop_name,
        line:        p.line,
        direction_id: p.direction_id,
        headsign:    p.headsign,
        platform:    p.platform,
        active:      p.active,
      })),
    }))

    return NextResponse.json({ results, count: results.length, query: q })
  } catch (err) {
    console.error('Stops search error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
