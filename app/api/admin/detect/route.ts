export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { detectPassages } from '@/lib/detector'

interface DetectBody {
  from?:    string
  to?:      string
  source?:  string
  dry_run?: boolean
}

export async function POST(req: NextRequest) {
  let body: DetectBody = {}
  try { body = await req.json() } catch { /* use defaults */ }

  const toDate   = body.to   ? new Date(body.to)   : new Date()
  const fromDate = body.from ? new Date(body.from)  : new Date(toDate.getTime() - 24 * 3600 * 1000)
  const dryRun   = body.dry_run === true

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return NextResponse.json({ error: 'Invalid from/to date' }, { status: 400 })
  }

  // Determine sources to process
  let sources: string[]
  if (typeof body.source === 'string' && body.source.trim()) {
    sources = [body.source.trim()]
  } else {
    const rows = (await sql`
      SELECT DISTINCT source FROM readings
      WHERE ts >= ${fromDate.toISOString()} AND ts <= ${toDate.toISOString()}
    `) as { source: string }[]
    sources = rows.map(r => r.source)
  }

  let passagesFound   = 0
  let readingsFlagged = 0

  for (const src of sources) {
    // 120-reading warm-up before range start (for BG_WIN + VOTE_WIN context)
    const warmupRows = (await sql`
      SELECT id, ts, db_cal, db_raw FROM readings
      WHERE source = ${src} AND ts < ${fromDate.toISOString()}
      ORDER BY ts DESC LIMIT 120
    `) as { id: bigint; ts: string; db_cal: number | null; db_raw: number }[]

    const inRangeRows = (await sql`
      SELECT id, ts, db_cal, db_raw FROM readings
      WHERE source = ${src}
        AND ts >= ${fromDate.toISOString()}
        AND ts <= ${toDate.toISOString()}
      ORDER BY ts ASC
    `) as { id: bigint; ts: string; db_cal: number | null; db_raw: number }[]

    const toDetectorRow = (r: { id: bigint; ts: string; db_cal: number | null; db_raw: number }) => ({
      id:   r.id,
      tsMs: new Date(r.ts).getTime(),
      db:   r.db_cal ?? r.db_raw,
    })

    const window = [...warmupRows.reverse().map(toDetectorRow), ...inRangeRows.map(toDetectorRow)]
    const passages = detectPassages(window)

    // Only flag IDs that are within the requested range
    const inRangeIdSet = new Set(inRangeRows.map(r => String(r.id)))
    const rangeStart   = fromDate.getTime()

    const flagIds = passages
      .flatMap(p => p.readingIds)
      .filter(id => inRangeIdSet.has(String(id)))
      .map(id => Number(id))

    passagesFound  += passages.filter(p => p.startMs >= rangeStart).length
    readingsFlagged += flagIds.length

    if (!dryRun && flagIds.length > 0) {
      await sql`
        UPDATE readings SET tram_flag = FALSE
        WHERE source = ${src}
          AND ts >= ${fromDate.toISOString()}
          AND ts <= ${toDate.toISOString()}
      `
      await sql`
        UPDATE readings SET tram_flag = TRUE
        WHERE id = ANY(${flagIds})
      `
    }
  }

  return NextResponse.json({
    sources_processed: sources,
    passages_found:    passagesFound,
    readings_flagged:  readingsFlagged,
    dry_run:           dryRun,
  })
}
