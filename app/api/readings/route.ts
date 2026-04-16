export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import type { Reading } from '@/lib/db'
import { isValidIso } from '@/lib/utils'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const source = searchParams.get('source') ?? 'both'
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const limitParam = searchParams.get('limit')
  const limit = Math.min(parseInt(limitParam ?? '500', 10), 1000)

  if (source !== 'exterior' && source !== 'interior' && source !== 'both') {
    return NextResponse.json({ error: 'source must be exterior, interior, or both' }, { status: 400 })
  }
  if (from && !isValidIso(from)) {
    return NextResponse.json({ error: 'Invalid from timestamp' }, { status: 400 })
  }
  if (to && !isValidIso(to)) {
    return NextResponse.json({ error: 'Invalid to timestamp' }, { status: 400 })
  }

  try {
    let rawRows

    if (source === 'both') {
      if (from && to) {
        rawRows = await sql`
          SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
          FROM readings
          WHERE ts >= ${from} AND ts <= ${to}
          ORDER BY ts ASC
          LIMIT ${limit}
        `
      } else if (from) {
        rawRows = await sql`
          SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
          FROM readings
          WHERE ts >= ${from}
          ORDER BY ts ASC
          LIMIT ${limit}
        `
      } else if (to) {
        rawRows = await sql`
          SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
          FROM readings
          WHERE ts <= ${to}
          ORDER BY ts DESC
          LIMIT ${limit}
        `
      } else {
        rawRows = await sql`
          SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
          FROM readings
          ORDER BY ts DESC
          LIMIT ${limit}
        `
      }
    } else {
      if (from && to) {
        rawRows = await sql`
          SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
          FROM readings
          WHERE source = ${source} AND ts >= ${from} AND ts <= ${to}
          ORDER BY ts ASC
          LIMIT ${limit}
        `
      } else if (from) {
        rawRows = await sql`
          SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
          FROM readings
          WHERE source = ${source} AND ts >= ${from}
          ORDER BY ts ASC
          LIMIT ${limit}
        `
      } else {
        rawRows = await sql`
          SELECT id, ts, source, db_raw, db_cal, tram_flag, tram_line, tram_stop, tram_dir
          FROM readings
          WHERE source = ${source}
          ORDER BY ts DESC
          LIMIT ${limit}
        `
      }
    }

    const rows = rawRows as unknown as Reading[]
    return NextResponse.json({ readings: rows, count: rows.length })
  } catch (err) {
    console.error('Readings API error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
