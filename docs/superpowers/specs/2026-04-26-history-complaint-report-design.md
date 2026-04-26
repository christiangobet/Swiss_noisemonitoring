# History Tab — Complaint Report Design

## Goal

Rework `/history` from a raw data explorer into a **noise complaint evidence builder**: a single-page view that runs acoustic tram detection on historical data, classifies passages as normal vs outlier, and tells the story: **"Out of N tram passages in this period, M were particularly loud — significantly louder than a typical passage at this location."**

The framing is not "trams are loud" (expected, accepted). It is: some passages are outlier events that warrant investigation by the operator. The report identifies those specific events with timestamps and evidence.

### Outlier definition

A passage is classified as **particularly loud** (outlier) when its peak dB exceeds the median passage peak for the period by more than `OUTLIER_DELTA = 8 dB`. This self-calibrates to the sensor location — the median is computed from all detected passages in the selected date range, so the threshold moves with the ambient conditions.

## Architecture

Three backend changes + one full page rework:

1. **`/api/history` — add `source` filter param** (existing route, one extra WHERE clause)
2. **`/api/history/stats` — new route** returning complaint-oriented aggregates for a source + date range
3. **`/api/export` — new route** streaming full uncapped CSV (no row limit)
4. **`app/history/page.tsx` — full rework** (single-page complaint layout)

Detection re-run reuses the existing **`/api/admin/detect`** (POST, already built).

---

## API Changes

### 1. `GET /api/history` — add `source` param

Add optional `source` query param. When present, add `AND source = $source` to all existing queries. No other changes.

### 2. `GET /api/history/stats`

New route. Returns complaint-oriented aggregates for one source over a date range.

**Query params:** `from` (ISO), `to` (ISO), `source` (required)

**Response:**
```json
{
  "total_readings": 20533,
  "coverage_pct": 95,
  "tram_passages": 14,
  "median_passage_peak_db": 58.3,
  "outlier_threshold_db": 66.3,
  "outlier_passages": 4,
  "avg_background_db": 39.2,
  "worst_peak_db": 74.1,
  "passages": [
    {
      "start_ts": "2026-04-25T08:14:23Z",
      "end_ts": "2026-04-25T08:14:35Z",
      "duration_sec": 12,
      "peak_db": 71.4,
      "is_outlier": true
    }
  ]
}
```

**SQL logic:**
- `total_readings`: COUNT(*) for source + range
- `coverage_pct`: COUNT(DISTINCT DATE_TRUNC('hour', ts)) / total_possible_hours × 100
- Tram passages: group consecutive `tram_flag = TRUE` rows with gap > 2 min → one passage per group
- `avg_background_db`: Leq of readings where `tram_flag = FALSE`
- `median_passage_peak_db`: PERCENTILE_CONT(0.5) of MAX(db_cal) per passage
- `outlier_threshold_db`: median_passage_peak_db + 8
- `outlier_passages`: count of passages where peak > outlier_threshold_db
- `worst_peak_db`: MAX(db_cal) where `tram_flag = TRUE`
- `passages`: one row per detected passage with start, end, peak, `is_outlier` bool

### 3. `GET /api/export`

New route. Streams full CSV with no row limit.

**Query params:** `from` (ISO), `to` (ISO), `source` (optional, omit = all sources)

**Response:** `Content-Type: text/csv`, `Content-Disposition: attachment; filename=tramwatch-{source}-{from}-{to}.csv`

**CSV columns:** `timestamp,source,db_raw,db_cal,tram_flag`

**Implementation:** Stream via `new Response(ReadableStream)` — fetch rows in batches of 5000 using keyset pagination (`WHERE ts > $last_ts LIMIT 5000`) to avoid loading all rows into memory.

---

## History Page Rework

### Layout (top to bottom)

**Controls row:**
- Date range pickers (from / to)
- Source dropdown — populated from `SELECT DISTINCT source` in range; "All sources" option shows all
- Resolution toggle (Minute / Hour / Day) — used for chart only, not stat cards
- Refresh button
- ⚡ Re-detect button — POST `/api/admin/detect` with `{ source, from, to, dry_run: false }`, shows spinner, refreshes stats on completion
- ↓ PDF button — jsPDF export of the visible page (reuse pattern from `/reports`)
- ↓ Export CSV button — GET `/api/export?source=...&from=...&to=...`, triggers download

**Stat cards (4 cards, shown when a single source is selected):**
| Card | Value | Colour |
|------|-------|--------|
| Tram passages | N detected | amber |
| Outlier passages | M of N were particularly loud | red (if M > 0) |
| Typical passage | median peak dB | blue |
| Worst outlier | peak dB of loudest passage | red |

Outlier threshold shown as a subtitle under the second card: "peak > [outlier_threshold_db] dB (median +8 dB)".

When "All sources" selected: hide stat cards, show chart only (multi-source view unchanged).

**Chart:** Recharts ComposedChart — existing Leq + L_peak lines, filtered to selected source. Tram passage ReferenceArea bands from stats.passages timestamps. Resolution toggle controls aggregation.

**Tram passage table** (shown only when single source selected, after Re-detect has run):
Columns: `Time (Zurich)`, `Duration`, `Peak dB`, `Above background`
Sorted by time ASC. Row highlighted red if peak > 55 dB (day) or > 45 dB (night).

**Auto-generated narrative** (shown below table when stats are loaded):
> "Between [from] and [to], [N] tram passages were acoustically detected at the [source] measurement point. The typical passage peaked at [median_peak] dB(A). Of these, [M] passages were particularly loud — peaking above [outlier_threshold] dB(A), more than 8 dB above the typical event. The loudest outlier reached [worst_peak] dB(A). These [M] events are the focus of this report."

Text is copyable. Generates from stats API response, no AI needed.

**Tram passage table** rows: `is_outlier = true` rows highlighted amber. Table sorted by peak dB descending so worst offenders appear first. Columns: `Time (Zurich)`, `Duration`, `Peak dB`, `vs typical` (delta from median, e.g. +12 dB), `Outlier` (✓ or —).

---

## File Map

| Action | File |
|--------|------|
| Modify | `app/api/history/route.ts` — add `source` filter |
| Create | `app/api/history/stats/route.ts` — complaint aggregates + passages list |
| Create | `app/api/export/route.ts` — uncapped CSV stream |
| Rewrite | `app/history/page.tsx` — full complaint layout |

---

## Out of Scope

- Multi-source comparison in complaint view (stat cards only for single source)
- Editing/overriding individual tram flag detections manually
- Scheduling automated reports
- Sending email directly from the app

---

## Success Criteria

1. `gm1356` shows tram passages after clicking Re-detect (currently 0 flags)
2. Export CSV downloads all 20,533 readings for `gm1356` without cap
3. Narrative paragraph is factually correct and copy-pasteable into an email
4. PDF export captures stat cards + chart + table + narrative on one page
