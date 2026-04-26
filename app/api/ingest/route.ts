export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidIso } from '@/lib/utils'
import { getUpcomingTrams, findTramAtTime, type TramDeparture } from '@/lib/transport'


interface IngestReading {
  ts: string
  db_raw: number
}

interface IngestBody {
  source?: string
  readings: IngestReading[]
}

export async function POST(req: NextRequest) {
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

  const rawSource = typeof body.source === 'string' ? body.source.trim() : ''
  const source = /^[a-zA-Z0-9_-]{1,32}$/.test(rawSource) ? rawSource : 'pi'

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

  // Fetch calibration offset for this source from device_calibrations
  let offsetDb = 0
  try {
    const calibRows = await sql`
      SELECT offset_db FROM device_calibrations
      WHERE source = ${source} AND active = TRUE
      ORDER BY created_at DESC LIMIT 1
    `
    if (calibRows.length > 0) offsetDb = calibRows[0].offset_db as number
  } catch { /* non-fatal */ }

  // Fetch upcoming trams for auto-flagging
  let trams: TramDeparture[] | null = null
  try {
    const activeStops = await sql`
      SELECT stop_id FROM tram_stops_config WHERE active = TRUE
    `
    if (activeStops.length > 0) {
      trams = await getUpcomingTrams(activeStops.map(s => String(s.stop_id)))
    }
  } catch { /* non-fatal */ }

  let inserted = 0
  for (const r of body.readings) {
    const dbCal = r.db_raw + offsetDb
    let tramFlag = false
    let tramLine: string | null = null
    let tramDir: string | null = null
    let tramStop: string | null = null

    if (trams) {
      const match = findTramAtTime(trams, new Date(r.ts), 90)
      if (match) {
        tramFlag = true
        tramLine = match.line
        tramDir  = match.direction
        tramStop = match.stop_name
      }
    }

    await sql`
      INSERT INTO readings (ts, source, db_raw, db_cal, tram_flag, tram_line, tram_dir, tram_stop)
      VALUES (${r.ts}, ${source}, ${r.db_raw}, ${dbCal}, ${tramFlag}, ${tramLine}, ${tramDir}, ${tramStop})
    `
    inserted++
  }

  return NextResponse.json({ inserted, offset_applied: offsetDb, source, tram_schedule_active: trams !== null })
}
