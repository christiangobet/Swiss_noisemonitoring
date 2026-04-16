export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

interface StartBody {
  duration_sec: number
}

export async function POST(req: NextRequest) {
  let body: StartBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { duration_sec } = body
  if (![30, 60, 120].includes(duration_sec)) {
    return NextResponse.json({ error: 'duration_sec must be 30, 60, or 120' }, { status: 400 })
  }

  // Check both sensors are online (last reading within 30s)
  const now = Date.now()
  const extLast = await sql`
    SELECT ts FROM readings WHERE source = 'exterior' ORDER BY ts DESC LIMIT 1
  `
  const intLast = await sql`
    SELECT ts FROM readings WHERE source = 'interior' ORDER BY ts DESC LIMIT 1
  `

  const extTs = extLast[0]?.ts ? new Date(extLast[0].ts as string).getTime() : 0
  const intTs = intLast[0]?.ts ? new Date(intLast[0].ts as string).getTime() : 0

  if (now - extTs > 30000) {
    return NextResponse.json(
      { error: 'Exterior sensor is offline. Check Pi #1 before calibrating.' },
      { status: 409 }
    )
  }
  if (now - intTs > 30000) {
    return NextResponse.json(
      { error: 'Interior sensor is offline. Check Pi #2 before calibrating.' },
      { status: 409 }
    )
  }

  const startedAt = new Date().toISOString()
  const endsAt = new Date(Date.now() + duration_sec * 1000).toISOString()

  // Store as a pending calibration row (active=false, notes='PENDING:<session_id>')
  const result = await sql`
    INSERT INTO calibrations (duration_sec, ext_mean_db, int_mean_db, offset_db, active, notes, created_at)
    VALUES (${duration_sec}, 0, 0, 0, FALSE, ${'PENDING:' + startedAt}, ${startedAt})
    RETURNING id
  `

  const sessionId = result[0].id as number

  return NextResponse.json({ session_id: sessionId, started_at: startedAt, ends_at: endsAt, duration_sec })
}
