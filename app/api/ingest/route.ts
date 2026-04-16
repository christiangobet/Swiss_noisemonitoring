export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidIso } from '@/lib/utils'

interface IngestReading {
  ts: string
  db_raw: number
}

interface IngestBody {
  source: 'exterior' | 'interior'
  readings: IngestReading[]
}

export async function POST(req: NextRequest) {
  // Auth
  const apiKey = req.headers.get('x-api-key')
  if (!apiKey || apiKey !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: IngestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Validate source
  if (body.source !== 'exterior' && body.source !== 'interior') {
    return NextResponse.json({ error: 'source must be "exterior" or "interior"' }, { status: 400 })
  }

  // Validate readings array
  if (!Array.isArray(body.readings) || body.readings.length === 0) {
    return NextResponse.json({ error: 'readings must be a non-empty array' }, { status: 400 })
  }
  if (body.readings.length > 30) {
    return NextResponse.json({ error: 'readings batch must not exceed 30 items' }, { status: 400 })
  }

  for (const r of body.readings) {
    if (!isValidIso(r.ts)) {
      return NextResponse.json({ error: `Invalid timestamp: ${r.ts}` }, { status: 400 })
    }
    if (typeof r.db_raw !== 'number' || !isFinite(r.db_raw)) {
      return NextResponse.json({ error: 'db_raw must be a finite number' }, { status: 400 })
    }
    if (r.db_raw < 0 || r.db_raw > 200) {
      return NextResponse.json({ error: 'db_raw out of plausible range (0–200)' }, { status: 400 })
    }
  }

  // Fetch calibration offset for interior
  let offsetDb = 0
  if (body.source === 'interior') {
    const calibRows = await sql`
      SELECT offset_db FROM calibrations WHERE active = TRUE ORDER BY created_at DESC LIMIT 1
    `
    if (calibRows.length > 0) {
      offsetDb = calibRows[0].offset_db as number
    }
  }

  // Build and run bulk insert
  const rows = body.readings.map(r => ({
    ts: r.ts,
    source: body.source,
    db_raw: r.db_raw,
    db_cal: body.source === 'exterior' ? r.db_raw : r.db_raw + offsetDb,
  }))

  // Insert rows one at a time using parameterised queries
  // (Neon tagged template doesn't support dynamic array-of-values bulk insert natively)
  let inserted = 0
  for (const row of rows) {
    await sql`
      INSERT INTO readings (ts, source, db_raw, db_cal)
      VALUES (${row.ts}, ${row.source}, ${row.db_raw}, ${row.db_cal})
    `
    inserted++
  }

  return NextResponse.json({ inserted, offset_applied: offsetDb })
}
