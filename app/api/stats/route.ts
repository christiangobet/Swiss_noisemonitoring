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

    // Day Leq exterior
    const dayLeqExt = await sql`
      SELECT 10 * LOG(AVG(POWER(10, db_cal / 10))) AS leq
      FROM readings
      WHERE source = 'exterior'
        AND db_cal IS NOT NULL
        AND ts >= ${since}
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 6
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 22
    `

    // Night Leq exterior
    const nightLeqExt = await sql`
      SELECT 10 * LOG(AVG(POWER(10, db_cal / 10))) AS leq
      FROM readings
      WHERE source = 'exterior'
        AND db_cal IS NOT NULL
        AND ts >= ${since}
        AND (EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 6
          OR EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 22)
    `

    // Day Leq interior
    const dayLeqInt = await sql`
      SELECT 10 * LOG(AVG(POWER(10, db_cal / 10))) AS leq
      FROM readings
      WHERE source = 'interior'
        AND db_cal IS NOT NULL
        AND ts >= ${since}
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 6
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 22
    `

    // Night Leq interior
    const nightLeqInt = await sql`
      SELECT 10 * LOG(AVG(POWER(10, db_cal / 10))) AS leq
      FROM readings
      WHERE source = 'interior'
        AND db_cal IS NOT NULL
        AND ts >= ${since}
        AND (EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 6
          OR EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 22)
    `

    // Mean attenuation (exterior - interior, matched by minute)
    const attenuationResult = await sql`
      SELECT AVG(e.db_cal - i.db_cal) AS attenuation
      FROM readings e
      JOIN readings i
        ON DATE_TRUNC('minute', e.ts) = DATE_TRUNC('minute', i.ts)
      WHERE e.source = 'exterior'
        AND i.source = 'interior'
        AND e.db_cal IS NOT NULL
        AND i.db_cal IS NOT NULL
        AND e.ts >= ${since}
    `

    // Tram delta: mean dB during tram windows vs background
    const tramDeltaResult = await sql`
      WITH tram AS (
        SELECT AVG(db_cal) AS mean_tram
        FROM readings
        WHERE source = 'exterior' AND db_cal IS NOT NULL
          AND tram_flag = TRUE AND ts >= ${since}
      ),
      bg AS (
        SELECT AVG(db_cal) AS mean_bg
        FROM readings
        WHERE source = 'exterior' AND db_cal IS NOT NULL
          AND tram_flag = FALSE AND ts >= ${since}
      )
      SELECT tram.mean_tram - bg.mean_bg AS tram_delta
      FROM tram, bg
    `

    // Exceedance minutes (exterior over ES II limits)
    const exceedDayResult = await sql`
      SELECT COUNT(DISTINCT DATE_TRUNC('minute', ts)) AS cnt
      FROM readings
      WHERE source = 'exterior'
        AND db_cal > ${NOISE_LIMITS.day}
        AND ts >= ${since}
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 6
        AND EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 22
    `

    const exceedNightResult = await sql`
      SELECT COUNT(DISTINCT DATE_TRUNC('minute', ts)) AS cnt
      FROM readings
      WHERE source = 'exterior'
        AND db_cal > ${NOISE_LIMITS.night}
        AND ts >= ${since}
        AND (EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') < 6
          OR EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich') >= 22)
    `

    // By tram line
    const byLine = await sql`
      SELECT
        tram_line AS line,
        tram_dir AS headsign,
        COUNT(*) AS count,
        AVG(e.db_cal) AS mean_db_ext,
        AVG(i.db_cal) AS mean_db_int
      FROM readings e
      LEFT JOIN readings i
        ON DATE_TRUNC('minute', e.ts) = DATE_TRUNC('minute', i.ts)
        AND i.source = 'interior'
      WHERE e.source = 'exterior'
        AND e.tram_flag = TRUE
        AND e.tram_line IS NOT NULL
        AND e.ts >= ${since}
      GROUP BY e.tram_line, e.tram_dir
      ORDER BY count DESC
    `

    // By hour (24-element array)
    const byHour = await sql`
      SELECT
        EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich')::int AS hour,
        10 * LOG(AVG(CASE WHEN source='exterior' THEN POWER(10, db_cal/10) END)) AS leq_ext,
        10 * LOG(AVG(CASE WHEN source='interior' THEN POWER(10, db_cal/10) END)) AS leq_int
      FROM readings
      WHERE db_cal IS NOT NULL AND ts >= ${since}
      GROUP BY EXTRACT(HOUR FROM ts AT TIME ZONE 'Europe/Zurich')
      ORDER BY hour
    `

    // Tram events count today
    const tramEventsTodayResult = await sql`
      SELECT COUNT(DISTINCT DATE_TRUNC('minute', ts)) AS cnt
      FROM readings
      WHERE tram_flag = TRUE
        AND ts >= ${since}
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
      day_leq_ext: dayLeqExt[0]?.leq ?? null,
      night_leq_ext: nightLeqExt[0]?.leq ?? null,
      day_leq_int: dayLeqInt[0]?.leq ?? null,
      night_leq_int: nightLeqInt[0]?.leq ?? null,
      attenuation_mean_db: attenuationResult[0]?.attenuation ?? null,
      tram_delta_db: tramDeltaResult[0]?.tram_delta ?? null,
      exceedance_minutes_day: Number(exceedDayResult[0]?.cnt ?? 0),
      exceedance_minutes_night: Number(exceedNightResult[0]?.cnt ?? 0),
      tram_events_count: Number(tramEventsTodayResult[0]?.cnt ?? 0),
      last_tram: lastTramResult[0] ?? null,
      limits: NOISE_LIMITS,
      by_line: byLine.map(r => ({
        line: r.line,
        headsign: r.headsign,
        count: Number(r.count),
        mean_db_ext: r.mean_db_ext,
        mean_db_int: r.mean_db_int,
      })),
      by_hour: byHour.map(r => ({
        hour: r.hour,
        leq_ext: r.leq_ext,
        leq_int: r.leq_int,
      })),
    })
  } catch (err) {
    console.error('Stats API error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
