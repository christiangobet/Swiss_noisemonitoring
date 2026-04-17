export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

interface StartBody {
  ref_source: string
  duration_sec: number
}

export async function POST(req: NextRequest) {
  let body: StartBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { ref_source, duration_sec } = body

  if (!ref_source || !/^[a-zA-Z0-9_-]{1,32}$/.test(ref_source)) {
    return NextResponse.json({ error: 'ref_source must be a valid source name' }, { status: 400 })
  }
  if (![30, 60, 120].includes(duration_sec)) {
    return NextResponse.json({ error: 'duration_sec must be 30, 60, or 120' }, { status: 400 })
  }

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

  // Need ≥2 sources active in the last 30s
  const activeRows = await sql`
    SELECT DISTINCT ON (source) source
    FROM readings
    WHERE ts >= NOW() - INTERVAL '30 seconds'
    ORDER BY source, ts DESC
  `
  const activeSources = activeRows.map(r => r.source as string)

  if (activeSources.length < 2) {
    return NextResponse.json(
      { error: `Need ≥2 active sources to calibrate. Only ${activeSources.length} active.` },
      { status: 409 }
    )
  }
  if (!activeSources.includes(ref_source)) {
    return NextResponse.json(
      { error: `Reference source "${ref_source}" is not active. Active: ${activeSources.join(', ')}` },
      { status: 409 }
    )
  }

  const startedAt = new Date().toISOString()
  const endsAt = new Date(Date.now() + duration_sec * 1000).toISOString()

  const result = await sql`
    INSERT INTO calib_sessions (started_at, ends_at, duration_sec, ref_source, status)
    VALUES (${startedAt}, ${endsAt}, ${duration_sec}, ${ref_source}, 'running')
    RETURNING id
  `

  return NextResponse.json({
    session_id: Number(result[0].id),
    started_at: startedAt,
    ends_at: endsAt,
    duration_sec,
    ref_source,
    active_sources: activeSources,
  })
}
