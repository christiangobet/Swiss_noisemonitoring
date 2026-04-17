export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'

const GAP_MS     = 3 * 60 * 1000  // readings > 3 min apart = separate passages
const MIN_READS  = 2               // ignore single stray flagged readings

export async function POST() {
  try {
    // Ensure table exists
    await sql`
      CREATE TABLE IF NOT EXISTS tram_passages (
        id            BIGSERIAL PRIMARY KEY,
        detected_at   TIMESTAMPTZ NOT NULL,
        tram_line     TEXT NOT NULL,
        tram_dir      TEXT NOT NULL,
        tram_stop     TEXT,
        peak_db_ext   REAL NOT NULL,
        mean_db_ext   REAL NOT NULL,
        duration_s    REAL NOT NULL,
        reading_count INT NOT NULL,
        UNIQUE (tram_line, tram_dir, detected_at)
      )
    `

    // Flagged exterior readings not yet in a passage window
    // (re-processing all is fine — UNIQUE constraint deduplicates)
    const rows = await sql`
      SELECT ts, db_cal, tram_line, tram_dir, tram_stop
      FROM readings
      WHERE tram_flag   = TRUE
        AND db_cal IS NOT NULL
        AND tram_line   IS NOT NULL
      ORDER BY tram_line, tram_dir, ts ASC
    `

    if (rows.length === 0) {
      return NextResponse.json({ passages_created: 0, message: 'No flagged readings yet' })
    }

    // ── Cluster into discrete passages ────────────────────────────────────────
    interface Point { ts: Date; db: number }
    interface Cluster {
      line: string; dir: string; stop: string | null
      points: Point[]
    }

    const clusters: Cluster[] = []
    let cur: Cluster | null = null

    for (const r of rows) {
      const ts   = new Date(String(r.ts))
      const db   = r.db_cal as number
      const line = String(r.tram_line)
      const dir  = String(r.tram_dir)
      const stop = r.tram_stop ? String(r.tram_stop) : null

      const gap = cur ? ts.getTime() - cur.points.at(-1)!.ts.getTime() : Infinity
      const sameRun = cur && cur.line === line && cur.dir === dir && gap <= GAP_MS

      if (sameRun) {
        cur!.points.push({ ts, db })
      } else {
        cur = { line, dir, stop, points: [{ ts, db }] }
        clusters.push(cur)
      }
    }

    // ── Convert clusters → passage rows ───────────────────────────────────────
    let inserted = 0
    for (const c of clusters) {
      if (c.points.length < MIN_READS) continue

      const peak     = c.points.reduce((a, b) => a.db >= b.db ? a : b)
      const meanDb   = c.points.reduce((s, p) => s + p.db, 0) / c.points.length
      const durationS = (c.points.at(-1)!.ts.getTime() - c.points[0].ts.getTime()) / 1000

      await sql`
        INSERT INTO tram_passages
          (detected_at, tram_line, tram_dir, tram_stop, peak_db_ext, mean_db_ext, duration_s, reading_count)
        VALUES (
          ${peak.ts.toISOString()},
          ${c.line},
          ${c.dir},
          ${c.stop},
          ${peak.db},
          ${meanDb},
          ${durationS},
          ${c.points.length}
        )
        ON CONFLICT (tram_line, tram_dir, detected_at) DO NOTHING
      `
      inserted++
    }

    return NextResponse.json({ passages_created: inserted, clusters_found: clusters.length })
  } catch (err) {
    console.error('events/detect error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
