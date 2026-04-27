// app/api/export/route.ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidIso } from '@/lib/utils'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const from   = searchParams.get('from')
  const to     = searchParams.get('to')
  const source = searchParams.get('source')

  if (!from || !isValidIso(from)) return NextResponse.json({ error: 'Invalid from' }, { status: 400 })
  if (!to   || !isValidIso(to))   return NextResponse.json({ error: 'Invalid to' },   { status: 400 })

  try {
    const rows = source
      ? await sql`
          SELECT ts, source, db_raw, db_cal, tram_flag
          FROM readings
          WHERE source = ${source}
            AND ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz
          ORDER BY ts ASC, source ASC`
      : await sql`
          SELECT ts, source, db_raw, db_cal, tram_flag
          FROM readings
          WHERE ts >= ${from}::timestamptz AND ts <= ${to}::timestamptz
          ORDER BY ts ASC, source ASC`

    const header = 'timestamp,source,db_raw,db_cal,tram_flag\n'
    const body = (rows as { ts: Date | string; source: string; db_raw: number | null; db_cal: number | null; tram_flag: boolean }[])
      .map(r =>
        `${new Date(r.ts).toISOString()},${r.source},${r.db_raw != null ? r.db_raw.toFixed(2) : ''},${r.db_cal != null ? r.db_cal.toFixed(2) : ''},${r.tram_flag}`
      )
      .join('\n')

    const srcLabel = source ?? 'all'
    const fromDate = from.substring(0, 10)
    const toDate   = to.substring(0, 10)
    const filename = `tramwatch-${srcLabel}-${fromDate}-${toDate}.csv`

    return new NextResponse(header + body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    console.error('Export error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
