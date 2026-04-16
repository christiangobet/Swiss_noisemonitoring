export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import type { Calibration } from '@/lib/db'

export async function GET() {
  try {
    const activeRows = await sql`
      SELECT id, created_at, duration_sec, ext_mean_db, int_mean_db, offset_db, active, notes
      FROM calibrations
      WHERE active = TRUE
      ORDER BY created_at DESC
      LIMIT 1
    `
    const active = activeRows as unknown as Calibration[]

    const historyRows = await sql`
      SELECT id, created_at, duration_sec, ext_mean_db, int_mean_db, offset_db, active, notes
      FROM calibrations
      ORDER BY created_at DESC
      LIMIT 10
    `
    const history = historyRows as unknown as Calibration[]

    // Sensor last-seen
    const lastSeenExt = await sql`
      SELECT ts FROM readings WHERE source = 'exterior' ORDER BY ts DESC LIMIT 1
    `
    const lastSeenInt = await sql`
      SELECT ts FROM readings WHERE source = 'interior' ORDER BY ts DESC LIMIT 1
    `

    const now = Date.now()
    const extTs = lastSeenExt[0]?.ts ? new Date(lastSeenExt[0].ts as string).getTime() : null
    const intTs = lastSeenInt[0]?.ts ? new Date(lastSeenInt[0].ts as string).getTime() : null

    // Online = last reading within 30 seconds
    const extOnline = extTs ? now - extTs < 30000 : false
    const intOnline = intTs ? now - intTs < 30000 : false

    return NextResponse.json({
      active: active[0] ?? null,
      history,
      sensors: {
        exterior: {
          online: extOnline,
          last_seen: lastSeenExt[0]?.ts ?? null,
        },
        interior: {
          online: intOnline,
          last_seen: lastSeenInt[0]?.ts ?? null,
        },
      },
    })
  } catch (err) {
    console.error('Calibration GET error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
