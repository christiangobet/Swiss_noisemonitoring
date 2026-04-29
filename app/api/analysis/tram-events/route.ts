export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidIso } from '@/lib/utils'

const LIMIT = 2000

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to   = searchParams.get('to')

  if (!from || !isValidIso(from)) return NextResponse.json({ error: 'Invalid from' }, { status: 400 })
  if (!to   || !isValidIso(to))   return NextResponse.json({ error: 'Invalid to' },   { status: 400 })

  const rows = await sql`
    SELECT
      ts,
      tram_line AS line,
      tram_dir  AS direction,
      db_cal
    FROM readings
    WHERE tram_flag = TRUE
      AND ts >= ${from}::timestamptz
      AND ts <= ${to}::timestamptz
      AND tram_line IS NOT NULL
    ORDER BY ts ASC
    LIMIT ${LIMIT}
  `

  return NextResponse.json({ events: rows, capped: rows.length === LIMIT })
}
