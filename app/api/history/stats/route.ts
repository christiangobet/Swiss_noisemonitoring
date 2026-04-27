// app/api/history/stats/route.ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidIso } from '@/lib/utils'

const OUTLIER_DELTA = 8  // dB above median passage peak → outlier

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const from   = searchParams.get('from')
  const to     = searchParams.get('to')
  const source = searchParams.get('source')

  if (!from || !isValidIso(from)) return NextResponse.json({ error: 'Invalid from' }, { status: 400 })
  if (!to   || !isValidIso(to))   return NextResponse.json({ error: 'Invalid to' },   { status: 400 })
  if (!source)                     return NextResponse.json({ error: 'source required' }, { status: 400 })

  try {
    // ── Passages (group tram_flag=TRUE runs, gap > 2 min = new passage) ──────
    const passageRows = await sql`
      WITH flagged AS (
        SELECT ts, db_cal,
          LAG(ts) OVER (ORDER BY ts) AS prev_ts
        FROM readings
        WHERE source = ${source}
          AND ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz
          AND tram_flag = TRUE AND db_cal IS NOT NULL
      ),
      grouped AS (
        SELECT ts, db_cal,
          SUM(CASE WHEN prev_ts IS NULL OR ts - prev_ts > INTERVAL '2 minutes' THEN 1 ELSE 0 END)
            OVER (ORDER BY ts) AS passage_id
        FROM flagged
      ),
      passages AS (
        SELECT
          passage_id,
          MIN(ts)  AS start_ts,
          MAX(ts)  AS end_ts,
          EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts)))::int AS duration_sec,
          MAX(db_cal) AS peak_db
        FROM grouped
        GROUP BY passage_id
      ),
      with_median AS (
        SELECT *,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY peak_db) OVER () AS median_peak
        FROM passages
      )
      SELECT
        start_ts, end_ts, duration_sec,
        ROUND(peak_db::numeric, 1)::float8   AS peak_db,
        ROUND(median_peak::numeric, 1)::float8 AS median_peak,
        peak_db > (median_peak + ${OUTLIER_DELTA}) AS is_outlier
      FROM with_median
      ORDER BY peak_db DESC
    ` as {
      start_ts: string; end_ts: string; duration_sec: number;
      peak_db: number; median_peak: number; is_outlier: boolean
    }[]

    // ── Background Leq (non-tram readings) ────────────────────────────────────
    const bgRows = await sql`
      SELECT ROUND((10 * LOG(AVG(POWER(10, db_cal / 10.0))))::numeric, 1) AS leq
      FROM readings
      WHERE source = ${source}
        AND ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz
        AND tram_flag = FALSE AND db_cal IS NOT NULL
    ` as { leq: number }[]

    // ── Coverage % ────────────────────────────────────────────────────────────
    const covRows = await sql`
      SELECT
        COUNT(DISTINCT DATE_TRUNC('hour', ts))::int AS hours_with_data,
        GREATEST(1, ROUND(EXTRACT(EPOCH FROM (${to}::timestamptz - ${from}::timestamptz)) / 3600))::int AS total_hours,
        COUNT(*)::int AS total_readings
      FROM readings
      WHERE source = ${source}
        AND ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz
    ` as { hours_with_data: number; total_hours: number; total_readings: number }[]

    const cov = covRows[0]
    const medianPeak = passageRows[0]?.median_peak ?? null
    const outlierThreshold = medianPeak !== null ? medianPeak + OUTLIER_DELTA : null
    const outlierCount = passageRows.filter(p => p.is_outlier).length

    return NextResponse.json({
      total_readings:       Number(cov.total_readings),
      coverage_pct:         Math.round(Number(cov.hours_with_data) / Number(cov.total_hours) * 100),
      tram_passages:        passageRows.length,
      median_passage_peak_db: medianPeak,
      outlier_threshold_db:   outlierThreshold,
      outlier_passages:       outlierCount,
      avg_background_db:      bgRows[0]?.leq ?? null,
      worst_peak_db:          passageRows[0]?.peak_db ?? null,
      passages:               passageRows,
    })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '42P01') {
      return NextResponse.json({ total_readings: 0, tram_passages: 0, passages: [] })
    }
    console.error('Stats API error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
