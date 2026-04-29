import { neon, Pool } from '@neondatabase/serverless'

// Neon does not validate the connection string at initialisation time — only at
// first query. Providing a placeholder URL makes the module safe to import during
// Next.js build without DATABASE_URL being set. All routes use `force-dynamic`
// so no queries run at build time; a missing env var will surface as a clear
// runtime error on the first actual request.
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://build-placeholder:x@placeholder/db'

export const sql = neon(DATABASE_URL, { fetchOptions: { cache: 'no-store' } })

// Pool client for multi-statement DDL (used in /api/setup).
// Uses the non-pooling direct URL so PgBouncer transaction mode doesn't
// interfere with CREATE TABLE / CREATE INDEX statements.
export function createPool() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL environment variable is not set')
  return new Pool({ connectionString: url })
}

// Schema migration SQL — all tables created idempotently
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS readings (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL,
  source       TEXT NOT NULL,
  db_raw       REAL NOT NULL,
  db_cal       REAL,
  tram_flag    BOOLEAN DEFAULT FALSE,
  tram_line    TEXT,
  tram_stop    TEXT,
  tram_dir     TEXT,
  device_id    TEXT,
  device_label TEXT
);

CREATE INDEX IF NOT EXISTS readings_ts_idx ON readings (ts DESC);
CREATE INDEX IF NOT EXISTS readings_source_ts_idx ON readings (source, ts DESC);

CREATE TABLE IF NOT EXISTS leq_minute (
  minute_ts   TIMESTAMPTZ PRIMARY KEY,
  leq_ext     REAL,
  leq_int     REAL,
  delta_db    REAL,
  l10_ext     REAL,
  l10_int     REAL,
  l90_ext     REAL,
  l90_int     REAL,
  tram_events INT DEFAULT 0,
  tram_lines  TEXT
);

CREATE TABLE IF NOT EXISTS calibrations (
  id           SERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  duration_sec INT NOT NULL,
  ext_mean_db  REAL NOT NULL,
  int_mean_db  REAL NOT NULL,
  offset_db    REAL NOT NULL,
  active       BOOLEAN DEFAULT TRUE,
  notes        TEXT
);

CREATE TABLE IF NOT EXISTS tram_stops_config (
  id           SERIAL PRIMARY KEY,
  stop_id      TEXT NOT NULL UNIQUE,
  stop_name    TEXT NOT NULL,
  line         TEXT NOT NULL,
  direction_id INT,
  headsign     TEXT,
  platform     TEXT,
  active       BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS gtfs_meta (
  id           SERIAL PRIMARY KEY,
  fetched_at   TIMESTAMPTZ DEFAULT NOW(),
  feed_version TEXT,
  valid_from   DATE,
  valid_to     DATE
);

CREATE TABLE IF NOT EXISTS tram_line_offsets (
  id          SERIAL PRIMARY KEY,
  line        TEXT NOT NULL,
  direction   TEXT NOT NULL,
  offset_sec  INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line, direction)
);
`

// Types mirroring DB rows
export interface Reading {
  id: number
  ts: string
  source: string
  db_raw: number
  db_cal: number | null
  tram_flag: boolean
  tram_line: string | null
  tram_stop: string | null
  tram_dir: string | null
  device_id: string | null
  device_label: string | null
}

export interface LeqMinute {
  minute_ts: string
  leq_ext: number | null
  leq_int: number | null
  delta_db: number | null
  l10_ext: number | null
  l10_int: number | null
  l90_ext: number | null
  l90_int: number | null
  tram_events: number
  tram_lines: string | null
}

export interface Calibration {
  id: number
  created_at: string
  duration_sec: number
  ext_mean_db: number
  int_mean_db: number
  offset_db: number
  active: boolean
  notes: string | null
}

export interface TramStopConfig {
  id: number
  stop_id: string
  stop_name: string
  line: string
  direction_id: number | null
  headsign: string | null
  platform: string | null
  active: boolean
}

export interface GtfsMeta {
  id: number
  fetched_at: string
  feed_version: string | null
  valid_from: string | null
  valid_to: string | null
}

export interface TramLineOffset {
  id: number
  line: string
  direction: string
  offset_sec: number
  updated_at: string
}

// Swiss noise limits (ES II residential zone, LSV)
export { NOISE_LIMITS, isNighttime } from './utils'
