#!/usr/bin/env bash
# Extract noise readings + tram events for 2026-04-27 08:00–20:30 CEST (06:00–18:30 UTC)
# Usage: DATABASE_URL="postgresql://..." bash extract_daily.sh
# Or:    source .env.local && bash extract_daily.sh

set -euo pipefail

DATE="2026-04-27"
FROM_UTC="${DATE}T06:00:00Z"   # 08:00 CEST
TO_UTC="${DATE}T18:30:00Z"     # 20:30 CEST
OUTDIR="exports"
mkdir -p "$OUTDIR"

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -f ".env.local" ]]; then
    # shellcheck disable=SC1091
    export $(grep -v '^#' .env.local | grep 'DATABASE_URL' | xargs)
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "  Run: DATABASE_URL='postgresql://...' bash extract_daily.sh"
  echo "  Or create .env.local with DATABASE_URL=..."
  exit 1
fi

echo "=== Extracting data for $DATE (08:00–20:30 CEST) ==="

# ── 1. All readings ──────────────────────────────────────────────────────────
echo "[1/3] Readings → $OUTDIR/readings_${DATE}.csv"
psql "$DATABASE_URL" --no-password -t -A -F',' \
  -c "\copy (
    SELECT
      id,
      ts AT TIME ZONE 'Europe/Zurich' AS ts_local,
      ts AT TIME ZONE 'UTC'           AS ts_utc,
      source,
      ROUND(db_raw::numeric, 2)  AS db_raw,
      ROUND(db_cal::numeric, 2)  AS db_cal,
      tram_flag,
      tram_line,
      tram_stop,
      tram_dir,
      device_id,
      device_label
    FROM readings
    WHERE ts >= '${FROM_UTC}' AND ts <= '${TO_UTC}'
    ORDER BY ts ASC
  ) TO STDOUT WITH CSV HEADER" \
  > "$OUTDIR/readings_${DATE}.csv"

ROW_COUNT=$(tail -n +2 "$OUTDIR/readings_${DATE}.csv" | wc -l)
echo "    → ${ROW_COUNT} readings"

# ── 2. Tram passage events (tram_flag=TRUE readings grouped into events) ─────
echo "[2/3] Tram events → $OUTDIR/tram_events_${DATE}.csv"
psql "$DATABASE_URL" --no-password -t -A -F',' \
  -c "\copy (
    WITH flagged AS (
      SELECT
        ts,
        source,
        db_raw,
        db_cal,
        tram_line,
        tram_stop,
        tram_dir,
        LAG(ts) OVER (ORDER BY ts) AS prev_ts
      FROM readings
      WHERE tram_flag = TRUE
        AND ts >= '${FROM_UTC}'
        AND ts <= '${TO_UTC}'
    ),
    grouped AS (
      SELECT *,
        SUM(CASE WHEN prev_ts IS NULL OR ts - prev_ts > INTERVAL '2 minutes' THEN 1 ELSE 0 END)
          OVER (ORDER BY ts) AS event_id
      FROM flagged
    )
    SELECT
      event_id,
      MIN(ts AT TIME ZONE 'Europe/Zurich') AS started_at_local,
      MAX(ts AT TIME ZONE 'Europe/Zurich') AS ended_at_local,
      MIN(ts AT TIME ZONE 'UTC')           AS started_at_utc,
      MAX(ts AT TIME ZONE 'UTC')           AS ended_at_utc,
      EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts)))::INT AS duration_sec,
      COUNT(*)                             AS reading_count,
      tram_line,
      MAX(tram_stop)                       AS tram_stop,
      MAX(tram_dir)                        AS tram_dir,
      ROUND(MAX(COALESCE(db_cal, db_raw))::numeric, 1) AS peak_db,
      ROUND(AVG(COALESCE(db_cal, db_raw))::numeric, 1) AS mean_db,
      ROUND(MIN(COALESCE(db_cal, db_raw))::numeric, 1) AS min_db
    FROM grouped
    GROUP BY event_id, tram_line
    ORDER BY started_at_utc
  ) TO STDOUT WITH CSV HEADER" \
  > "$OUTDIR/tram_events_${DATE}.csv"

EVENT_COUNT=$(tail -n +2 "$OUTDIR/tram_events_${DATE}.csv" | wc -l)
echo "    → ${EVENT_COUNT} tram events"

# ── 3. Tram schedule from transport.opendata.ch API ──────────────────────────
echo "[3/3] Tram schedule from API → $OUTDIR/tram_schedule_api_${DATE}.csv"

# Get active stop IDs from DB
STOP_IDS=$(psql "$DATABASE_URL" --no-password -t -A \
  -c "SELECT stop_id FROM tram_stops_config WHERE active = TRUE" 2>/dev/null || echo "")

echo "stop_id,stop_name,line,direction,category,scheduled,expected" \
  > "$OUTDIR/tram_schedule_api_${DATE}.csv"

if [[ -z "$STOP_IDS" ]]; then
  echo "    → No active stops configured in DB; skipping API call"
else
  API_ROWS=0
  while IFS= read -r stop_id; do
    [[ -z "$stop_id" ]] && continue
    echo "    Querying stop: $stop_id"

    # Use limit=200 to get as many departures as possible (API max ~100)
    RESP=$(curl -sf --max-time 15 \
      "https://transport.opendata.ch/v1/stationboard?station=${stop_id}&limit=100" \
      -H "User-Agent: TramWatch-extract/1.0" || echo '{}')

    # Parse JSON with Python (always available) and write CSV rows
    python3 - <<PYEOF >> "$OUTDIR/tram_schedule_api_${DATE}.csv"
import json, sys, re

stop_id = "${stop_id}"
resp = json.loads('''${RESP}'''.replace("'", "'\"'\"'"))
station = resp.get('station', {})
stop_name = station.get('name', stop_id) if station else stop_id

def fix_offset(s):
    if not s:
        return ''
    return re.sub(r'([+-])(\d{2})(\d{2})$', r'\1\2:\3', s)

for d in (resp.get('stationboard') or []):
    cat = str(d.get('category', '')).strip().lower()
    name = d.get('name', '')
    line = re.sub(r'^[A-Za-z]+\s*', '', name).split()[0] if name else d.get('number', '')
    direction = d.get('to', '')
    stop = d.get('stop') or {}
    sched = fix_offset(stop.get('departure') or '')
    prog   = fix_offset((stop.get('prognosis') or {}).get('departure') or '')
    expected = prog or sched
    if not sched:
        continue
    def esc(v):
        v = str(v).replace('"', '""')
        return f'"{v}"' if ',' in v or '"' in v else v
    print(','.join([esc(stop_id), esc(stop_name), esc(line), esc(direction), esc(cat), esc(sched), esc(expected)]))
PYEOF

    ROWS_THIS=$(grep -c "^" "$OUTDIR/tram_schedule_api_${DATE}.csv" 2>/dev/null || echo 0)
    API_ROWS=$((ROWS_THIS - 1))  # subtract header
  done <<< "$STOP_IDS"
  echo "    → ${API_ROWS} API schedule entries"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Done. Files written to ./$OUTDIR/ ==="
ls -lh "$OUTDIR/"*"${DATE}"* 2>/dev/null
