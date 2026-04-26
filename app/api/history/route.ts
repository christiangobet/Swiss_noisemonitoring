export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidIso } from '@/lib/utils'

const RAW_LIMIT = 7200

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const from       = searchParams.get('from')
  const to         = searchParams.get('to')
  const resolution = searchParams.get('resolution') ?? 'hour'

  if (!from || !isValidIso(from)) return NextResponse.json({ error: 'Invalid from' }, { status: 400 })
  if (!to   || !isValidIso(to))   return NextResponse.json({ error: 'Invalid to' },   { status: 400 })
  if (!['minute', 'hour', 'day'].includes(resolution))
    return NextResponse.json({ error: 'Invalid resolution' }, { status: 400 })

  const sourceFilter = searchParams.get('source')

  try {
    if (resolution === 'minute') {
      // Return raw 1-second readings so the UI can render an oscilloscope-style view
      // with tram-flagged windows highlighted.
      const rows = await sql`
        SELECT ts, source, db_cal, tram_flag
        FROM readings
        WHERE ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz
          AND db_cal IS NOT NULL
          ${sourceFilter ? sql`AND source = ${sourceFilter}` : sql``}
        ORDER BY ts ASC, source ASC
        LIMIT ${RAW_LIMIT}`
      return NextResponse.json({ raw: rows, capped: rows.length === RAW_LIMIT })
    }

    if (resolution === 'hour') {
      const [stats, eventRows] = await Promise.all([
        sql`
          SELECT DATE_TRUNC('hour', ts) AS bucket,
                 source,
                 10 * LOG(AVG(POWER(10, db_cal / 10.0))) AS leq,
                 MAX(db_cal) AS l_peak,
                 COUNT(*)::int AS n
          FROM readings
          WHERE ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz AND db_cal IS NOT NULL
            ${sourceFilter ? sql`AND source = ${sourceFilter}` : sql``}
          GROUP BY 1, source ORDER BY 1 ASC, source ASC`,
        sql`
          WITH flagged AS (
            SELECT ts, source,
                   LAG(ts) OVER (PARTITION BY source ORDER BY ts) AS prev_ts
            FROM readings
            WHERE tram_flag = TRUE
              AND ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz
              ${sourceFilter ? sql`AND source = ${sourceFilter}` : sql``}
          ),
          with_events AS (
            SELECT ts, source,
                   DATE_TRUNC('hour', ts) AS bucket,
                   SUM(CASE WHEN prev_ts IS NULL OR ts - prev_ts > INTERVAL '2 minutes' THEN 1 ELSE 0 END)
                     OVER (PARTITION BY source ORDER BY ts) AS eid
            FROM flagged
          )
          SELECT bucket, source, COUNT(DISTINCT eid)::int AS event_count
          FROM with_events
          GROUP BY 1, source`,
      ])

      const evMap = new Map<string, number>()
      for (const r of eventRows) {
        evMap.set(`${String(r.bucket)}|${String(r.source)}`, Number(r.event_count))
      }

      const points = stats.map(r => ({
        bucket: r.bucket,
        source: r.source,
        leq: Number(r.leq),
        l_peak: Number(r.l_peak),
        n: Number(r.n),
        event_count: evMap.get(`${String(r.bucket)}|${String(r.source)}`) ?? 0,
      }))
      return NextResponse.json({ points })
    }

    // resolution === 'day'
    const rows = await sql`
      SELECT DATE_TRUNC('day', ts AT TIME ZONE 'Europe/Zurich') AT TIME ZONE 'Europe/Zurich' AS bucket,
             source,
             10 * LOG(AVG(POWER(10, db_cal / 10.0))) AS leq,
             COUNT(*)::int AS n
      FROM readings
      WHERE ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz AND db_cal IS NOT NULL
        ${sourceFilter ? sql`AND source = ${sourceFilter}` : sql``}
      GROUP BY 1, source ORDER BY 1 ASC, source ASC`
    return NextResponse.json({ points: rows })

  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '42P01') {
      return NextResponse.json({ points: [], raw: [], capped: false })
    }
    console.error('History API error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
