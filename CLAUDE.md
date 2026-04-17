# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # start dev server (http://localhost:3000)
npm run build    # production build
npm run lint     # ESLint via next lint
```

There are no automated tests. TypeScript checking:
```bash
npx tsc --noEmit   # if typescript is installed globally
./node_modules/.bin/tsc --noEmit
```

## Architecture

**TramWatch** is a Next.js 14 App Router app that monitors tram noise levels in Zürich and compares them against Swiss LSV ES II residential limits (55 dB day / 45 dB night). It is deployed on Vercel and uses a Neon Postgres database.

### Data ingestion

The primary ingestion model is **browser-based, multi-source**: any number of browser instances (phones, laptops, etc.) can record simultaneously. Each device has a free-text source name (`[a-zA-Z0-9_-]{1,32}`, e.g. `"interior"`, `"roof"`, `"iphone"`) stored in `localStorage` as `tramwatchSource` and configured in Settings. Each unique source name appears as its own line on the live chart.

`/api/browser-ingest` — no API key, accepts any valid source name, applies calibration offset, does **not** auto-flag trams (user presses `T` in the live chart instead). Implemented in `components/dashboard/live-chart.tsx`.

There is also a legacy **Raspberry Pi path** (`pi-daemons/`) that POSTs to `/api/ingest` with `x-api-key: INGEST_SECRET`. The exterior Pi uses a Benetech GM1356 USB SPL meter (HID); the interior Pi uses PyAudio. This route still validates source as the fixed strings `"exterior"` or `"interior"` and performs tram auto-flagging via the transport.opendata.ch stationboard API.

### Database (`lib/db.ts`)

Neon Postgres accessed via `@neondatabase/serverless`. Two client modes:
- `sql` (tagged template) — used in all API routes for single statements
- `createPool()` — used only in `/api/setup` for multi-statement DDL migrations

The `MIGRATION_SQL` constant in `lib/db.ts` is the canonical schema. Tables: `readings`, `leq_minute`, `calibrations`, `tram_stops_config`, `gtfs_meta`.

**Important:** `lib/db.ts` still has the old `CHECK (source IN ('exterior','interior'))` constraint in `MIGRATION_SQL` and the `Reading.source` type. The live ingest routes drop this constraint at runtime (`ALTER TABLE readings DROP CONSTRAINT IF EXISTS readings_source_check`), but `MIGRATION_SQL` and the `Reading` type need updating to reflect free-text sources.

All API routes set `export const dynamic = 'force-dynamic'` to prevent build-time query execution.

Environment variables required:
- `DATABASE_URL` — Neon pooled connection string
- `DATABASE_URL_UNPOOLED` — direct (non-pooled) connection for DDL
- `INGEST_SECRET` — shared secret for Pi daemon authentication

### Live chart data flow

`/api/live` returns `{ sources: Record<string, Reading[]>, fetched_at }` — one key per source name with the last 3 minutes of readings (max 120 per source, ascending order). The `LiveChart` component polls this every 2 s, merges it with live mic data into flat `ChartPoint` objects (`{ tsMs, [sourceName]: dB }`), and renders one Recharts `<Line>` per source with auto-assigned colors from `SOURCE_COLORS`.

### GTFS / tram schedule

`lib/gtfs.ts` parses GTFS zip files from opendata.swiss. Stop configuration is saved by users via `/api/stops/save` and stored in `tram_stops_config`. `/api/tram-schedule` calls `transport.opendata.ch/v1/stationboard` for real-time departures. A Vercel cron (`vercel.json`) refreshes GTFS data every Monday at 03:00 UTC via `/api/gtfs/refresh` (maxDuration: 300 s).

### Pages and components

- `/` — dashboard: `LiveChart`, `StatCards`, `TramStats`, `NextTrams`, `TopBar`
- `/settings` — device source name, tram stop search, GTFS refresh, sensor status
- `/calibration` — wizard that runs both sensors side-by-side and computes `offset_db` saved to `calibrations` table
- `/history` — historical readings browser
- `/reports` — PDF export via jsPDF

UI components in `components/ui/` are shadcn/ui primitives. Layout is `components/layout/app-shell.tsx` wrapping a sidebar (`components/layout/sidebar.tsx`) and mobile nav.

