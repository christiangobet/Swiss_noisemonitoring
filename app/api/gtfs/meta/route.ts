export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export async function GET() {
  try {
    const rows = await sql`
      SELECT id, fetched_at, feed_version, valid_from, valid_to
      FROM gtfs_meta
      ORDER BY fetched_at DESC
      LIMIT 1
    `
    if (rows.length === 0) {
      return NextResponse.json({ meta: null })
    }
    const row = rows[0]
    return NextResponse.json({
      meta: {
        fetched_at:   row.fetched_at,
        feed_version: row.feed_version ?? null,
        valid_from:   row.valid_from   ? String(row.valid_from).substring(0, 10) : null,
        valid_to:     row.valid_to     ? String(row.valid_to).substring(0, 10)   : null,
      },
    })
  } catch (err) {
    console.error('gtfs/meta error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
