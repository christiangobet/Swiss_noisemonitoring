export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export async function GET() {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()

    const rows = await sql`
      SELECT
        EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich')::int AS hour,
        EXTRACT(DOW FROM ts AT TIME ZONE 'Europe/Zurich')::int AS dow,
        AVG(db_cal) AS mean_db
      FROM readings
      WHERE source = 'exterior'
        AND db_cal IS NOT NULL
        AND ts >= ${since}
      GROUP BY
        EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich'),
        EXTRACT(DOW FROM ts AT TIME ZONE 'Europe/Zurich')
      ORDER BY hour, dow
    `

    // Build 24x7 matrix (hours 0-23, days 0=Sun .. 6=Sat)
    const matrix: (number | null)[][] = Array.from({ length: 24 }, () => Array(7).fill(null))

    for (const row of rows) {
      const h = row.hour as number
      const d = row.dow as number
      matrix[h][d] = typeof row.mean_db === 'number' ? Math.round(row.mean_db * 10) / 10 : null
    }

    const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`)
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

    return NextResponse.json({ matrix, hours, days })
  } catch (err) {
    console.error('Heatmap API error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
