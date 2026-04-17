export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'

// Diagnostic endpoint — shows recent reading counts per source + device.
// Accessible from any browser: GET /api/debug
export async function GET() {
  try {
    const rows = await sql`
      SELECT
        source,
        device_label,
        device_id,
        COUNT(*)::int          AS total,
        MAX(ts)                AS last_ts,
        MIN(ts)                AS first_ts,
        ROUND(AVG(db_raw)::numeric, 1) AS avg_db
      FROM readings
      WHERE ts > NOW() - INTERVAL '10 minutes'
      GROUP BY source, device_label, device_id
      ORDER BY source, last_ts DESC
    `

    const recent = await sql`
      SELECT ts, source, db_raw, db_cal, device_label, device_id
      FROM readings
      ORDER BY ts DESC
      LIMIT 10
    `

    return NextResponse.json({
      by_source_device: rows,
      last_10_readings: recent,
      server_time: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
