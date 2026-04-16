export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

interface SaveBody {
  stops: string[]  // array of stop_ids to mark active; all others deactivated
}

export async function POST(req: NextRequest) {
  let body: SaveBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!Array.isArray(body.stops)) {
    return NextResponse.json({ error: 'stops must be an array of stop_id strings' }, { status: 400 })
  }

  try {
    // Deactivate all current stops
    await sql`UPDATE tram_stops_config SET active = FALSE`

    // Activate the selected ones
    if (body.stops.length > 0) {
      for (const stopId of body.stops) {
        await sql`
          UPDATE tram_stops_config SET active = TRUE WHERE stop_id = ${stopId}
        `
      }
    }

    const active = await sql`
      SELECT stop_id, stop_name, line, direction_id, headsign, platform, active
      FROM tram_stops_config
      WHERE active = TRUE
      ORDER BY stop_name
    `

    return NextResponse.json({ success: true, active_stops: active, count: active.length })
  } catch (err) {
    console.error('Stops save error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
