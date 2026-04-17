export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { NOISE_LIMITS } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const hoursParam = searchParams.get('hours')
  const hours = Math.min(parseInt(hoursParam ?? '24', 10), 720)

  if (isNaN(hours) || hours < 1) {
    return NextResponse.json({ error: 'hours must be a positive integer up to 720' }, { status: 400 })
  }

  try {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()

    // Day Leq — all sources combined
    const dayLeq = await sql`
      SELECT 10 * LOG(AVG(POWER(10, db_cal / 10))) AS leq
      FROM readings
      WHERE db_cal IS NOT NULL
        AND ts >= ${since}
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 6
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 22
    `

    // Night Leq — all sources combined
    const nightLeq = await sql`
      SELECT 10 * LOG(AVG(POWER(10, db_cal / 10))) AS leq
      FROM readings
      WHERE db_cal IS NOT NULL
        AND ts >= ${since}
        AND (EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 6
          OR EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 22)
    `

    // Tram delta: mean dB during tram windows vs background
    const tramDeltaResult = await sql`
      WITH tram AS (
        SELECT AVG(db_cal) AS mean_tram
        FROM readings
        WHERE db_cal IS NOT NULL AND tram_flag = TRUE AND ts >= ${since}
      ),
      bg AS (
        SELECT AVG(db_cal) AS mean_bg
        FROM readings
        WHERE db_cal IS NOT NULL AND tram_flag = FALSE AND ts >= ${since}
      )
      SELECT tram.mean_tram - bg.mean_bg AS tram_delta
      FROM tram, bg
    `

    // Exceedance minutes over ES II day limit
    const exceedDayResult = await sql`
      SELECT COUNT(DISTINCT DATE_TRUNC('minute', ts)) AS cnt
      FROM readings
      WHERE db_cal > ${NOISE_LIMITS.day}
        AND ts >= ${since}
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 6
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 22
    `

    // Exceedance minutes over ES II night limit
    const exceedNightResult = await sql`
      SELECT COUNT(DISTINCT DATE_TRUNC('minute', ts)) AS cnt
      FROM readings
      WHERE db_cal > ${NOISE_LIMITS.night}
        AND ts >= ${since}
        AND (EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 6
          OR EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 22)
    `

    // By tram line — aggregated across all sources that recorded tram passages
    const byLine = await sql`
      SELECT
        tram_line AS line,
        tram_dir  AS headsign,
        COUNT(*)  AS count,
        AVG(db_cal) AS mean_db,
        MAX(db_cal) AS peak_db
      FROM readings
      WHERE tram_flag = TRUE
        AND tram_line IS NOT NULL
        AND db_cal IS NOT NULL
        AND ts >= ${since}
      GROUP BY tram_line, tram_dir
      ORDER BY count DESC
    `

    // By hour — all sources combined
    const byHour = await sql`
      SELECT
        EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich')::int AS hour,
        10 * LOG(AVG(POWER(10, db_cal / 10))) AS leq
      FROM readings
      WHERE db_cal IS NOT NULL AND ts >= ${since}
      GROUP BY EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich')
      ORDER BY hour
    `

    // Tram events count
    const tramEventsTodayResult = await sql`
      SELECT COUNT(DISTINCT DATE_TRUNC('minute', ts)) AS cnt
      FROM readings
      WHERE tram_flag = TRUE AND ts >= ${since}
    `

    // Last tram passage
    const lastTramResult = await sql`
      SELECT ts, tram_line, tram_dir
      FROM readings
      WHERE tram_flag = TRUE AND tram_line IS NOT NULL
      ORDER BY ts DESC
      LIMIT 1
    `

    return NextResponse.json({
      period_hours: hours,
      day_leq: dayLeq[0]?.leq ?? null,
      night_leq: nightLeq[0]?.leq ?? null,
      tram_delta_db: tramDeltaResult[0]?.tram_delta ?? null,
      exceedance_minutes_day: Number(exceedDayResult[0]?.cnt ?? 0),
      exceedance_minutes_night: Number(exceedNightResult[0]?.cnt ?? 0),
      tram_events_count: Number(tramEventsTodayResult[0]?.cnt ?? 0),
      last_tram: lastTramResult[0] ?? null,
      limits: NOISE_LIMITS,
      by_line: byLine.map(r => ({
        line:     r.line,
        headsign: r.headsign,
        count:    Number(r.count),
        mean_db:  r.mean_db,
        peak_db:  r.peak_db,
      })),
      by_hour: byHour.map(r => ({ hour: r.hour, leq: r.leq })),
    })
  } catch (err) {
    console.error('Stats API error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
