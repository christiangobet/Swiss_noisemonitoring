export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { computeLeq } from '@/lib/utils'

interface FinishBody {
  session_id: number
  notes?: string
}

export async function POST(req: NextRequest) {
  let body: FinishBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { session_id, notes } = body
  if (!session_id || typeof session_id !== 'number') {
    return NextResponse.json({ error: 'session_id must be a number' }, { status: 400 })
  }

  const sessionRows = await sql`
    SELECT id, started_at, ends_at, ref_source
    FROM calib_sessions
    WHERE id = ${session_id} AND status = 'running'
  `
  if (sessionRows.length === 0) {
    return NextResponse.json({ error: 'Session not found or already finished' }, { status: 404 })
  }

  const { started_at: startedAt, ends_at: endsAt, ref_source: refSource } = sessionRows[0] as {
    started_at: string; ends_at: string; ref_source: string
  }

  // Discover all sources that recorded in the window
  const sourceRows = await sql`
    SELECT DISTINCT source FROM readings
    WHERE ts >= ${startedAt} AND ts <= ${endsAt} AND db_raw IS NOT NULL
  `
  const sources = sourceRows.map(r => r.source as string)

  if (!sources.includes(refSource as string)) {
    return NextResponse.json(
      { error: `Reference source "${refSource}" has no readings in the session window.` },
      { status: 422 }
    )
  }
  if (sources.length < 2) {
    return NextResponse.json(
      { error: 'Fewer than 2 sources recorded during the session window.' },
      { status: 422 }
    )
  }

  // Compute Leq mean per source
  const sourceMeans: Record<string, { mean: number; count: number }> = {}
  for (const src of sources) {
    const rows = await sql`
      SELECT db_raw FROM readings
      WHERE source = ${src} AND ts >= ${startedAt} AND ts <= ${endsAt} AND db_raw IS NOT NULL
      ORDER BY ts
    `
    const values = rows.map(r => r.db_raw as number)
    const mean = computeLeq(values) ?? values.reduce((a, b) => a + b, 0) / values.length
    sourceMeans[src] = { mean, count: values.length }
  }

  const refMean = sourceMeans[refSource as string].mean

  // Deactivate all existing calibrations
  await sql`UPDATE device_calibrations SET active = FALSE`

  // Insert per-source rows and retroactively update readings
  const results: Array<{ source: string; mean_db: number; offset_db: number; sample_count: number }> = []
  for (const [src, { mean, count }] of Object.entries(sourceMeans)) {
    const offsetDb = refMean - mean
    await sql`
      INSERT INTO device_calibrations (session_id, source, mean_db, offset_db, sample_count, active)
      VALUES (${session_id}, ${src}, ${mean}, ${offsetDb}, ${count}, TRUE)
    `
    await sql`UPDATE readings SET db_cal = db_raw + ${offsetDb} WHERE source = ${src}`
    results.push({ source: src, mean_db: mean, offset_db: offsetDb, sample_count: count })
  }

  await sql`
    UPDATE calib_sessions SET status = 'done', notes = ${notes ?? null} WHERE id = ${session_id}
  `

  return NextResponse.json({ session_id, ref_source: refSource, sources: results })
}
