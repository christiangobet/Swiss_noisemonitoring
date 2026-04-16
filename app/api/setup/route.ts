export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql, createPool, MIGRATION_SQL } from '@/lib/db'

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const force = searchParams.get('force') === 'true'

  if (force) {
    const apiKey = req.headers.get('x-api-key')
    if (apiKey !== process.env.INGEST_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } else {
    try {
      const result = await sql`
        SELECT COUNT(*) as count
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('readings','leq_minute','calibrations','tram_stops_config','gtfs_meta')
      `
      const existingCount = Number(result[0]?.count ?? 0)
      if (existingCount >= 5) {
        return NextResponse.json({
          message: 'Tables already exist. Use ?force=true with x-api-key to re-run.',
          tables_found: existingCount,
        })
      }
    } catch {
      // DB not reachable — fall through and try to create
    }
  }

  const pool = createPool()
  const client = await pool.connect()
  try {
    // Run each DDL statement individually (Pool supports multi-statement)
    const statements = MIGRATION_SQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0)

    for (const stmt of statements) {
      await client.query(stmt)
    }

    const verification = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('readings','leq_minute','calibrations','tram_stops_config','gtfs_meta')
      ORDER BY table_name
    `

    return NextResponse.json({
      success: true,
      message: 'Database migration complete',
      tables: verification.map(r => r.table_name),
    })
  } catch (err) {
    console.error('Setup error:', err)
    return NextResponse.json(
      { error: 'Migration failed', detail: String(err) },
      { status: 500 }
    )
  } finally {
    client.release()
    await pool.end()
  }
}

export async function GET() {
  try {
    const result = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('readings','leq_minute','calibrations','tram_stops_config','gtfs_meta')
      ORDER BY table_name
    `
    const tables = result.map(r => r.table_name as string)
    const allPresent = tables.length === 5

    return NextResponse.json({
      ready: allPresent,
      tables_found: tables,
      missing: ['readings','leq_minute','calibrations','tram_stops_config','gtfs_meta']
        .filter(t => !tables.includes(t)),
    })
  } catch (err) {
    return NextResponse.json(
      { ready: false, error: 'Cannot reach database', detail: String(err) },
      { status: 503 }
    )
  }
}
