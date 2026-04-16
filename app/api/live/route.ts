export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import type { Reading } from '@/lib/db'

export async function GET() {
  try {
    const exteriorRows = await sql`
      SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
      FROM readings
      WHERE source = 'exterior'
      ORDER BY ts DESC
      LIMIT 120
    `
    const exterior = exteriorRows as unknown as Reading[]

    const interiorRows = await sql`
      SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
      FROM readings
      WHERE source = 'interior'
      ORDER BY ts DESC
      LIMIT 120
    `
    const interior = interiorRows as unknown as Reading[]

    // Return in ascending order (oldest first) for chart rendering
    return NextResponse.json({
      exterior: exterior.reverse(),
      interior: interior.reverse(),
      fetched_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('Live API error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
