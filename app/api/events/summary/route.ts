export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export async function GET() {
  try {
    const rows = await sql`
      SELECT
        tram_line,
        tram_dir,
        COUNT(*)                                    AS passage_count,
        ROUND(MAX(peak_db_ext)::numeric,  1)::float AS max_db,
        ROUND(AVG(peak_db_ext)::numeric,  1)::float AS avg_peak_db,
        ROUND(AVG(mean_db_ext)::numeric,  1)::float AS avg_mean_db,
        ROUND(AVG(duration_s)::numeric,   0)::int   AS avg_duration_s,
        MAX(detected_at)                            AS last_detected
      FROM tram_passages
      GROUP BY tram_line, tram_dir
      ORDER BY tram_line, tram_dir
    `

    return NextResponse.json({ summary: rows, count: rows.length })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return NextResponse.json({ summary: [], count: 0 })
    }
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
