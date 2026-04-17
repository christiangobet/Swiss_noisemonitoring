export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

interface ReactivateBody {
  session_id: number
}

export async function POST(req: NextRequest) {
  let body: ReactivateBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { session_id } = body
  if (!session_id || typeof session_id !== 'number') {
    return NextResponse.json({ error: 'session_id must be a number' }, { status: 400 })
  }

  const sessionRows = await sql`
    SELECT id FROM calib_sessions WHERE id = ${session_id} AND status = 'done'
  `
  if (sessionRows.length === 0) {
    return NextResponse.json({ error: 'Session not found or not completed' }, { status: 404 })
  }

  const calibRows = await sql`
    SELECT source, offset_db FROM device_calibrations WHERE session_id = ${session_id}
  `
  if (calibRows.length === 0) {
    return NextResponse.json({ error: 'No calibrations found for this session' }, { status: 404 })
  }

  await sql`UPDATE device_calibrations SET active = FALSE`
  await sql`UPDATE device_calibrations SET active = TRUE WHERE session_id = ${session_id}`

  for (const row of calibRows) {
    const src = row.source as string
    const offsetDb = row.offset_db as number
    await sql`UPDATE readings SET db_cal = db_raw + ${offsetDb} WHERE source = ${src}`
  }

  return NextResponse.json({
    success: true,
    session_id,
    sources: calibRows.map(r => ({ source: r.source, offset_db: r.offset_db })),
  })
}
