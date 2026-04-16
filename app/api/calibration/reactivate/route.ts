export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

interface ReactivateBody {
  calibration_id: number
}

export async function POST(req: NextRequest) {
  let body: ReactivateBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { calibration_id } = body
  if (!calibration_id || typeof calibration_id !== 'number') {
    return NextResponse.json({ error: 'calibration_id must be a number' }, { status: 400 })
  }

  // Verify it exists and is a completed (non-pending) calibration
  const existing = await sql`
    SELECT id, offset_db FROM calibrations
    WHERE id = ${calibration_id}
      AND (notes IS NULL OR notes NOT LIKE 'PENDING:%')
  `
  if (existing.length === 0) {
    return NextResponse.json({ error: 'Calibration not found' }, { status: 404 })
  }

  const offsetDb = existing[0].offset_db as number

  // Deactivate all, then activate the chosen one
  await sql`UPDATE calibrations SET active = FALSE`
  await sql`UPDATE calibrations SET active = TRUE WHERE id = ${calibration_id}`

  // Re-apply this offset to all interior readings
  await sql`
    UPDATE readings SET db_cal = db_raw + ${offsetDb} WHERE source = 'interior'
  `

  return NextResponse.json({ success: true, calibration_id, offset_db: offsetDb })
}
