export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidIso } from '@/lib/utils'

interface IngestReading {
  ts: string
  db_raw: number
}

// Browser-side interior ingest — no API key (browser can't hold secrets).
// Only accepts source: "interior".
export async function POST(req: NextRequest) {
  let body: { readings: IngestReading[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

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

  const calibRows = await sql`
    SELECT offset_db FROM calibrations WHERE active = TRUE ORDER BY created_at DESC LIMIT 1
  `
  const offsetDb: number = calibRows.length > 0 ? (calibRows[0].offset_db as number) : 0

  let inserted = 0
  for (const r of body.readings) {
    const dbCal = r.db_raw + offsetDb
    await sql`
      INSERT INTO readings (ts, source, db_raw, db_cal, tram_flag)
      VALUES (${r.ts}, 'interior', ${r.db_raw}, ${dbCal}, FALSE)
      ON CONFLICT DO NOTHING
    `
    inserted++
  }

  return NextResponse.json({ inserted, offset_applied: offsetDb })
}
