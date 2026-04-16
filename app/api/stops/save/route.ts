export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

interface StopData {
  stop_id: string
  stop_name: string
  line: string
  headsign: string | null
}

interface SaveBody {
  /** IDs of platforms to activate. */
  stops: string[]
  /** Full platform data for new stops (from search results). Used to upsert if not yet in DB. */
  stop_data?: StopData[]
}

export async function POST(req: NextRequest) {
  let body: SaveBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!Array.isArray(body.stops)) {
    return NextResponse.json({ error: 'stops must be an array of stop_id strings' }, { status: 400 })
  }

  try {
    // Ensure the table exists (idempotent — safe to run on every call)
    await sql`
      CREATE TABLE IF NOT EXISTS tram_stops_config (
        id           SERIAL PRIMARY KEY,
        stop_id      TEXT NOT NULL UNIQUE,
        stop_name    TEXT NOT NULL,
        line         TEXT NOT NULL DEFAULT '',
        direction_id INT,
        headsign     TEXT,
        platform     TEXT,
        active       BOOLEAN DEFAULT TRUE
      )
    `

    // Deactivate all existing active stops
    await sql`UPDATE tram_stops_config SET active = FALSE`

    if (body.stops.length > 0) {
      for (const stopId of body.stops) {
        // Find full data for this stop from the request (so we can upsert new stops)
        const data = body.stop_data?.find(s => s.stop_id === stopId)

        if (data) {
          // Upsert — handles both transport.opendata.ch IDs (new) and GTFS IDs (legacy)
          await sql`
            INSERT INTO tram_stops_config (stop_id, stop_name, line, headsign, active)
            VALUES (
              ${data.stop_id},
              ${data.stop_name},
              ${data.line || ''},
              ${data.headsign ?? null},
              TRUE
            )
            ON CONFLICT (stop_id) DO UPDATE SET
              stop_name = EXCLUDED.stop_name,
              line      = EXCLUDED.line,
              headsign  = EXCLUDED.headsign,
              active    = TRUE
          `
        } else {
          // Fallback: ID already in DB (from GTFS or prior save), just activate it
          await sql`
            UPDATE tram_stops_config SET active = TRUE WHERE stop_id = ${stopId}
          `
        }
      }
    }

    const active = await sql`
      SELECT stop_id, stop_name, line, direction_id, headsign, platform, active
      FROM tram_stops_config
      WHERE active = TRUE
      ORDER BY stop_name
    `

    return NextResponse.json({ success: true, active_stops: active, count: active.length })
  } catch (err) {
    console.error('Stops save error:', err)
    return NextResponse.json({ error: 'Database error', detail: String(err) }, { status: 503 })
  }
}
