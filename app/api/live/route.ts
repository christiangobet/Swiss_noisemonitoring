export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import type { Reading } from '@/lib/db'

export async function GET() {
  try {
    // Fetch last 3 min of readings for all sources in one query
    const rows = await sql`
      SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
      FROM readings
      WHERE ts >= NOW() - INTERVAL '3 minutes'
      ORDER BY source, ts DESC
    ` as unknown as (Reading & { source: string })[]

    // Group by source, cap at 120 rows each, then reverse to ascending order
    const bySource: Record<string, Reading[]> = {}
    for (const r of rows) {
      const src = r.source
      if (!bySource[src]) bySource[src] = []
      if (bySource[src].length < 120) bySource[src].push(r)
    }
    for (const src of Object.keys(bySource)) bySource[src].reverse()

    return NextResponse.json({ sources: bySource, fetched_at: new Date().toISOString() })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '42P01') {
      return NextResponse.json({ sources: {}, fetched_at: new Date().toISOString() })
    }
    console.error('Live API error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
