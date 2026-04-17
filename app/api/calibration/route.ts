export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export async function GET() {
  try {
    // Ensure tables exist
    await sql`
      CREATE TABLE IF NOT EXISTS calib_sessions (
        id           BIGSERIAL PRIMARY KEY,
        started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ends_at      TIMESTAMPTZ NOT NULL,
        duration_sec INT NOT NULL,
        ref_source   TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        notes        TEXT
      )
    `
    await sql`
      CREATE TABLE IF NOT EXISTS device_calibrations (
        id           BIGSERIAL PRIMARY KEY,
        session_id   BIGINT,
        source       TEXT NOT NULL,
        mean_db      REAL NOT NULL,
        offset_db    REAL NOT NULL DEFAULT 0,
        sample_count INT NOT NULL DEFAULT 0,
        active       BOOLEAN DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `

    // Active offset per source
    const offsetRows = await sql`
      SELECT DISTINCT ON (source)
        source, offset_db, created_at, session_id
      FROM device_calibrations
      WHERE active = TRUE
      ORDER BY source, created_at DESC
    `

    // Recent sessions with their per-source results
    const sessionRows = await sql`
      SELECT
        s.id, s.started_at, s.duration_sec, s.ref_source, s.status, s.notes,
        json_agg(json_build_object(
          'source', dc.source,
          'mean_db', dc.mean_db,
          'offset_db', dc.offset_db,
          'sample_count', dc.sample_count,
          'active', dc.active
        ) ORDER BY dc.source) AS sources
      FROM calib_sessions s
      LEFT JOIN device_calibrations dc ON dc.session_id = s.id
      WHERE s.status = 'done'
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT 10
    `

    // Active sources (recorded within last 30 s)
    const activeSourceRows = await sql`
      SELECT DISTINCT ON (source) source, ts
      FROM readings
      WHERE ts >= NOW() - INTERVAL '30 seconds'
      ORDER BY source, ts DESC
    `

    return NextResponse.json({
      active_offsets: offsetRows,
      sessions: sessionRows,
      active_sources: activeSourceRows.map(r => r.source as string),
    })
  } catch (err) {
    console.error('Calibration GET error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
