export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidIso } from '@/lib/utils'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const line = searchParams.get('line')
  const direction = searchParams.get('direction')

  if (from && !isValidIso(from)) {
    return NextResponse.json({ error: 'Invalid from timestamp' }, { status: 400 })
  }
  if (to && !isValidIso(to)) {
    return NextResponse.json({ error: 'Invalid to timestamp' }, { status: 400 })
  }

  const defaultFrom = from ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const defaultTo = to ?? new Date().toISOString()

  try {
    // Group consecutive tram_flag=true readings into events (gap > 2 min = new event)
    const rows = await sql`
      WITH flagged AS (
        SELECT
          ts,
          db_cal AS db_ext,
          tram_line,
          tram_stop,
          tram_dir,
          LAG(ts) OVER (ORDER BY ts) AS prev_ts
        FROM readings
        WHERE tram_flag = TRUE
          AND ts >= ${defaultFrom}
          AND ts <= ${defaultTo}
          AND (${line}::text IS NULL OR tram_line = ${line})
          AND (${direction}::text IS NULL OR tram_dir ILIKE ${'%' + (direction ?? '') + '%'})
        ORDER BY ts
      ),
      grouped AS (
        SELECT
          *,
          SUM(CASE WHEN prev_ts IS NULL OR ts - prev_ts > INTERVAL '2 minutes' THEN 1 ELSE 0 END)
            OVER (ORDER BY ts) AS event_id
        FROM flagged
      )
      SELECT
        event_id,
        MIN(ts) AS started_at,
        MAX(ts) AS ended_at,
        MAX(db_ext) AS peak_db_ext,
        AVG(db_ext) AS mean_db_ext,
        tram_line,
        MAX(tram_dir) AS tram_dir,
        MAX(tram_stop) AS tram_stop
      FROM grouped
      GROUP BY event_id, tram_line
      ORDER BY started_at DESC
      LIMIT 200
    `

    // Enrich with interior dB and background delta
    const events = await Promise.all(
      rows.map(async row => {
        const intResult = await sql`
          SELECT AVG(db_cal) AS mean_db_int, MAX(db_cal) AS peak_db_int
          FROM readings
          WHERE ts >= ${row.started_at as string}
            AND ts <= ${row.ended_at as string}
            AND db_cal IS NOT NULL
        `

        const bgResult = await sql`
          SELECT AVG(db_cal) AS bg_db
          FROM readings
          WHERE tram_flag = FALSE
            AND ts >= ${new Date(new Date(row.started_at as string).getTime() - 5 * 60000).toISOString()}
            AND ts < ${row.started_at as string}
            AND db_cal IS NOT NULL
        `

        const meanDbInt = intResult[0]?.mean_db_int ?? null
        const peakDbInt = intResult[0]?.peak_db_int ?? null
        const bgDb = bgResult[0]?.bg_db ?? null
        const attenuation =
          typeof row.mean_db_ext === 'number' && typeof meanDbInt === 'number'
            ? (row.mean_db_ext as number) - (meanDbInt as number)
            : null
        const deltaBg =
          typeof row.peak_db_ext === 'number' && bgDb !== null
            ? (row.peak_db_ext as number) - (bgDb as number)
            : null

        return {
          event_id: row.event_id,
          started_at: row.started_at,
          ended_at: row.ended_at,
          tram_line: row.tram_line,
          tram_dir: row.tram_dir,
          tram_stop: row.tram_stop,
          peak_db_ext: row.peak_db_ext,
          mean_db_ext: row.mean_db_ext,
          peak_db_int: peakDbInt,
          mean_db_int: meanDbInt,
          attenuation_db: attenuation,
          delta_bg_db: deltaBg,
        }
      })
    )

    return NextResponse.json({ events, count: events.length })
  } catch (err) {
    console.error('Tram events API error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
