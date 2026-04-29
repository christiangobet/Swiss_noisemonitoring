export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export async function GET() {
  const rows = await sql`
    SELECT line, direction, offset_sec
    FROM tram_line_offsets
    ORDER BY line ASC, direction ASC
  `
  return NextResponse.json({ offsets: rows })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { line, direction, offset_sec } = body

  if (typeof line !== 'string' || !line.trim())
    return NextResponse.json({ error: 'Invalid line' }, { status: 400 })
  if (typeof direction !== 'string' || !direction.trim())
    return NextResponse.json({ error: 'Invalid direction' }, { status: 400 })
  if (
    typeof offset_sec !== 'number' ||
    !Number.isInteger(offset_sec) ||
    offset_sec < -60 ||
    offset_sec > 60
  )
    return NextResponse.json({ error: 'offset_sec must be integer in [-60, 60]' }, { status: 400 })

  await sql`
    INSERT INTO tram_line_offsets (line, direction, offset_sec, updated_at)
    VALUES (${line.trim()}, ${direction.trim()}, ${offset_sec}, NOW())
    ON CONFLICT (line, direction)
    DO UPDATE SET offset_sec = EXCLUDED.offset_sec, updated_at = NOW()
  `
  return NextResponse.json({ ok: true })
}
