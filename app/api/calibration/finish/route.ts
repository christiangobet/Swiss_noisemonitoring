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

  // Fetch the pending calibration session
  const pending = await sql`
    SELECT id, created_at, duration_sec, notes
    FROM calibrations
    WHERE id = ${session_id} AND active = FALSE AND notes LIKE 'PENDING:%'
  `
  if (pending.length === 0) {
    return NextResponse.json({ error: 'Session not found or already finished' }, { status: 404 })
  }

  const session = pending[0]
  const startedAt = session.created_at as string
  const durationSec = session.duration_sec as number
  const endsAt = new Date(new Date(startedAt).getTime() + durationSec * 1000).toISOString()

  // Fetch readings from both sources in the session window
  const extReadings = await sql`
    SELECT db_cal FROM readings
    WHERE source = 'exterior'
      AND ts >= ${startedAt}
      AND ts <= ${endsAt}
      AND db_cal IS NOT NULL
    ORDER BY ts
  `
  const intReadings = await sql`
    SELECT db_cal FROM readings
    WHERE source = 'interior'
      AND ts >= ${startedAt}
      AND ts <= ${endsAt}
      AND db_cal IS NOT NULL
    ORDER BY ts
  `

  if (extReadings.length === 0) {
    return NextResponse.json(
      { error: 'No exterior readings found in calibration window. Is the exterior sensor online?' },
      { status: 422 }
    )
  }
  if (intReadings.length === 0) {
    return NextResponse.json(
      { error: 'No interior readings found in calibration window. Is the interior sensor online?' },
      { status: 422 }
    )
  }

  const extValues = extReadings.map(r => r.db_cal as number)
  const intValues = intReadings.map(r => r.db_cal as number)

  const extMean = computeLeq(extValues) ?? (extValues.reduce((a, b) => a + b, 0) / extValues.length)
  const intMean = computeLeq(intValues) ?? (intValues.reduce((a, b) => a + b, 0) / intValues.length)
  const offsetDb = extMean - intMean

  // Deactivate all previous active calibrations
  await sql`UPDATE calibrations SET active = FALSE WHERE active = TRUE`

  // Update the pending session to become the active calibration
  await sql`
    UPDATE calibrations
    SET
      active = TRUE,
      ext_mean_db = ${extMean},
      int_mean_db = intMean,
      offset_db = ${offsetDb},
      notes = ${notes ?? null}
    WHERE id = ${session_id}
  `

  // Fix typo: use parameter correctly
  await sql`
    UPDATE calibrations
    SET int_mean_db = ${intMean}
    WHERE id = ${session_id}
  `

  // Retroactively apply offset to all interior readings since last calibration
  // (readings since the previous active calibration was created)
  const prevCalib = await sql`
    SELECT created_at FROM calibrations
    WHERE active = FALSE AND notes NOT LIKE 'PENDING:%'
    ORDER BY created_at DESC
    LIMIT 1
  `
  const retroFrom = prevCalib[0]?.created_at ?? '2000-01-01T00:00:00Z'

  await sql`
    UPDATE readings
    SET db_cal = db_raw + ${offsetDb}
    WHERE source = 'interior'
      AND ts >= ${retroFrom as string}
  `

  return NextResponse.json({
    offset_db: offsetDb,
    ext_mean_db: extMean,
    int_mean_db: intMean,
    sample_count: Math.min(extReadings.length, intReadings.length),
    session_id,
  })
}
