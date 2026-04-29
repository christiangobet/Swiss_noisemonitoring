# Correlation View — Design Spec

**Date:** 2026-04-29
**Feature:** /analysis page overlaying noise, tram schedule, and Apple Health data

---

## Summary

A new `/analysis` page that renders a single overlay chart combining:
- Noise dB readings (per source, from Neon DB)
- Tram schedule markers (vertical dashed lines, shifted by calibrated per-line offsets)
- Apple Health data bands/lines (Sleep Stages, HR, HRV — per person)

Primary goal: correlation for personal insight + health-impact evidence for noise complaints.
Health data is person-tagged so multiple people's uploads coexist.

The whole app is gated behind a PIN (no existing auth). Health data is stored server-side (Neon DB) since the app runs on Vercel and is accessed from multiple devices.

---

## Build Phases

### Phase 1 — Auth + Analysis skeleton + Tram offsets
Deliverable: PIN-gated app, /analysis page with noise overlay + tram markers + offset calibration UI. No health data yet.

### Phase 2 — Health data
Deliverable: CSV upload (Health Export app format), person-name tagging, health layers on the chart.

---

## PIN Authentication

### Approach
Simple cookie-based PIN. No user accounts. One global PIN for the whole app.

### New env vars
| Var | Purpose |
|---|---|
| `APP_PIN` | The PIN (plain text, e.g. `"1234"`) — never stored in DB |
| `SESSION_SECRET` | 32-char random string for signing the session cookie |

### New files
- `middleware.ts` — Next.js middleware, runs on every request
- `app/login/page.tsx` — PIN entry form (shadcn/ui Input + Button, dark theme)
- `app/api/auth/login/route.ts` — POST `{ pin }` → compare to `APP_PIN` → set cookie
- `app/api/auth/logout/route.ts` — POST → clear cookie → redirect to /login

### Middleware logic
- Check for `tramwatch-session` httpOnly cookie (signed with `SESSION_SECRET` using `jose` or `iron-session`)
- If missing/invalid → `NextResponse.redirect('/login')`
- Excluded paths: `/login`, `/api/auth/*`, `/api/ingest`, `/_next/*`, `/favicon.ico`
  - `/api/ingest` is excluded because Pi daemons authenticate via `x-api-key` header, not a session cookie — blocking them would stop sensor ingestion
- Cookie max-age: 30 days

### Login page
- Centered card, PIN input (`type="password"`, max 8 chars), Submit button
- On error: "Incorrect PIN" inline message
- On success: redirect to `/` (or the originally requested path)

### Sidebar changes
- Add Logout button at the bottom of the sidebar (calls `/api/auth/logout`, redirects to /login)

---

## Phase 1 — /analysis Page

### Navigation
Add `{ href: '/analysis', label: 'Analysis', icon: BarChart2 }` to `NAV_ITEMS` in `components/layout/sidebar.tsx`. Position: between History and Reports.

### Page layout (`app/analysis/page.tsx`)
```
┌─ Time range selector ─────────────────────────────────┐
│  [24h] [48h] [7d] [30d] [3mo]  From [____] To [____] [Load] │
└───────────────────────────────────────────────────────┘
┌─ Correlation Chart ───────────────────────────────────┐
│  (noise lines + tram markers + health bands)          │
│                                                       │
└───────────────────────────────────────────────────────┘
┌─ Tram Offset Panel (collapsible) ─────────────────────┐
│  Line 2 →  [slider ±60s]  [value]                     │
│  Line 2 ←  [slider ±60s]  [value]                     │
│  Line 3 →  [slider ±60s]  [value]                     │
│  Line 3 ←  [slider ±60s]  [value]                     │
│  [Reset all]                          [Save offsets]  │
└───────────────────────────────────────────────────────┘
┌─ Health Upload Panel (Phase 2) ───────────────────────┐
│  (placeholder in Phase 1, activated in Phase 2)       │
└───────────────────────────────────────────────────────┘
```

### Time range selector
- Preset buttons: `24h`, `48h`, `7d`, `30d`, `3mo` — clicking a preset updates the From/To date inputs
- From / To date inputs always editable (override preset)
- Load button triggers data fetch
- Default on load: `7d`

### Correlation Chart (`components/analysis/correlation-chart.tsx`)
- Recharts `ComposedChart` with `ResponsiveContainer`
- **X-axis:** time (same pattern as history page, `formatZurichTime`)
- **Left Y-axis:** dB(A) — noise lines, one per source, colours from `SOURCE_COLORS`
- **Right Y-axis:** BPM — HR and HRV lines (Phase 2)
- **Tram markers:** `ReferenceLine` vertical, one per scheduled departure, colour-coded by line (line 2 = amber, line 3 = blue), dashed, label = line number + direction arrow. X position = scheduled time + `offset_sec`
- **Sleep bands** (Phase 2): `ReferenceArea` background bands per sleep stage (deep = indigo, REM = purple, light = slate, awake = transparent)
- **Layer toggles:** row of checkboxes/pills above the chart — toggle noise sources, tram lines, health metrics independently
- **Legend:** auto-generated from active layers
- Tram schedule data fetched from existing `/api/tram-schedule` endpoint, applying stored offsets client-side

### Tram Offset Panel (`components/analysis/tram-offset-panel.tsx`)
- Fetches current offsets from `GET /api/tram-offsets` on mount
- One row per line × direction pair (discovered from tram schedule response)
- Slider: range `-60` to `+60`, step `1` (seconds), accent colour matches line colour
- Value displayed as `+Xs` / `-Xs` / `0s` next to slider
- Sliders update chart in real-time (no save needed to see effect)
- "Save offsets" button → `POST /api/tram-offsets` for each changed row
- "Reset all" → sets all sliders to 0, saves immediately

---

## Phase 1 — DB & API

### New table: `tram_line_offsets`
```sql
CREATE TABLE IF NOT EXISTS tram_line_offsets (
  id          SERIAL PRIMARY KEY,
  line        TEXT NOT NULL,
  direction   TEXT NOT NULL,
  offset_sec  INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line, direction)
);
```
Added to `MIGRATION_SQL` in `lib/db.ts`.

### API: `/api/tram-offsets`
- `GET` — returns all rows as `{ offsets: { line, direction, offset_sec }[] }`
- `POST` — body `{ line, direction, offset_sec }` → `INSERT ... ON CONFLICT DO UPDATE` (upsert). Validates `offset_sec` is integer in [-60, 60].

---

## Phase 2 — Health Data

### Health Export CSV format
The "Health Export CSV" App Store app exports one CSV file per metric. Expected columns:
```
startDate, endDate, value, unit, sourceName
```
Dates in ISO 8601 (local time with timezone offset). The metric type is identified from the filename (e.g. `HeartRate.csv`, `HeartRateVariabilitySDNN.csv`, `SleepAnalysis.csv`).

> **Note:** Validate actual column names against a real export from the app before writing the parser. Column names may differ slightly.

Supported metric filenames → internal type mapping:
| Filename pattern | metric_type |
|---|---|
| `HeartRate` | `hr` |
| `HeartRateVariabilitySDNN` | `hrv` |
| `SleepAnalysis` | `sleep` |

Sleep `value` meanings: verify against an actual export — Health Export CSV may encode stages as strings (`"Deep"`, `"REM"`, `"Core"`, `"Awake"`) or integers depending on app version. Parser must handle both.

### Health Upload Panel (`components/analysis/health-upload-panel.tsx`)
- Person name text input (free text, stored as-is, e.g. `"Christian"`)
- File input accepting multiple CSV files
- Upload button → POST to `/api/health-data/upload` (multipart form)
- Shows upload progress and row counts per metric after success
- Existing uploads listed by person name with delete option

### New table: `health_readings`
```sql
CREATE TABLE IF NOT EXISTS health_readings (
  id          BIGSERIAL PRIMARY KEY,
  person_name TEXT NOT NULL,
  metric_type TEXT NOT NULL,         -- 'hr' | 'hrv' | 'sleep'
  start_ts    TIMESTAMPTZ NOT NULL,
  end_ts      TIMESTAMPTZ NOT NULL,
  value       NUMERIC NOT NULL,
  unit        TEXT NOT NULL,
  source_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS health_readings_range
  ON health_readings (person_name, metric_type, start_ts, end_ts);
```

### API: `/api/health-data/upload`
- Accepts `multipart/form-data`: field `person_name` (string) + one or more `file` fields (CSV)
- Parses each CSV, identifies metric type from filename
- Validates: `start_ts` < `end_ts`, `value` is numeric, `metric_type` is in allowed set
- Bulk-inserts into `health_readings` (batch of 1000 rows per INSERT to stay within Neon limits)
- Deletes existing rows for same `person_name` + `metric_type` before insert (replace-on-upload semantics)
- Returns `{ inserted: { hr: N, hrv: N, sleep: N } }`

### API: `/api/health-data`
- `GET ?from=&to=&person=&metric=` → returns rows in time range
- `person` and `metric` are optional filters (omit = all people / all metrics)
- Returns `{ readings: { person_name, metric_type, start_ts, end_ts, value, unit }[] }`

### Chart integration (Phase 2)
- `/analysis` page fetches health data alongside noise data and tram schedule
- Sleep stages rendered as `ReferenceArea` spans (coloured by stage value)
- HR rendered as a `Line` on the right Y-axis (BPM), one line per person, dashed
- HRV rendered as a `Line` on the right Y-axis (ms), one line per person, dotted
- Layer toggle pills: one per person × metric combination

---

## Files Summary

### New files (Phase 1)
| File | Purpose |
|---|---|
| `middleware.ts` | PIN auth gate |
| `app/login/page.tsx` | Login form |
| `app/api/auth/login/route.ts` | Login API |
| `app/api/auth/logout/route.ts` | Logout API |
| `app/analysis/page.tsx` | Analysis page |
| `app/api/tram-offsets/route.ts` | Tram offset CRUD |
| `components/analysis/correlation-chart.tsx` | Overlay chart |
| `components/analysis/tram-offset-panel.tsx` | Offset sliders |

### New files (Phase 2)
| File | Purpose |
|---|---|
| `app/api/health-data/route.ts` | Health readings query |
| `app/api/health-data/upload/route.ts` | CSV upload + parse |
| `components/analysis/health-upload-panel.tsx` | Upload UI |

### Modified files
| File | Change |
|---|---|
| `components/layout/sidebar.tsx` | Add Analysis nav + Logout button |
| `lib/db.ts` | Add MIGRATION_SQL for new tables |

---

## Out of scope
- Multi-PIN / user accounts
- Apple Watch live health streaming
- Exporting the correlation chart as PDF (can be added to Reports later)
- SpO2, respiratory rate, resting heart rate (deferred, can be added as metric types later)
