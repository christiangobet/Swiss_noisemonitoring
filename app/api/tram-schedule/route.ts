export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { getUpcomingTrams } from '@/lib/transport'

export async function GET() {
  try {
    const activeStops = await sql`
      SELECT stop_id, stop_name
      FROM tram_stops_config
      WHERE active = TRUE
    `

    if (activeStops.length === 0) {
      return NextResponse.json({ departures: [], count: 0, message: 'No active stops configured' })
    }

    const stopIds = activeStops.map(s => String(s.stop_id))
    const departures = await getUpcomingTrams(stopIds)

    return NextResponse.json({ departures, count: departures.length })
  } catch (err) {
    console.error('tram-schedule error:', err)
    return NextResponse.json({ error: 'Failed to fetch tram schedule', detail: String(err) }, { status: 503 })
  }
}
