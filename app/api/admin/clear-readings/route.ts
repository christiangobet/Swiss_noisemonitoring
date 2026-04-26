export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  if (body.confirm !== 'yes') {
    return NextResponse.json({ error: 'Missing confirm field' }, { status: 400 })
  }

  try {
    const result = await sql`DELETE FROM readings`
    const deleted = result.length ?? (result as unknown as { rowCount: number }).rowCount ?? 0
    return NextResponse.json({ ok: true, deleted })
  } catch (err: unknown) {
    console.error('Clear readings error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
