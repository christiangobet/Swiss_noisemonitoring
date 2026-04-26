/**
 * Client for the transport.opendata.ch API (free, no auth required).
 * Used for stop search and real-time tram stationboard data.
 */

const BASE = 'https://transport.opendata.ch/v1'
const UA = { 'User-Agent': 'TramWatch/1.0' }

export interface OdchPlatform {
  stop_id: string
  stop_name: string
  line: string        // comma-separated if multiple lines
  headsign: string | null
  active: boolean
}

export interface TramDeparture {
  stop_id: string
  stop_name: string
  line: string
  direction: string
  category: string
  /** Scheduled departure — ISO 8601 with offset, e.g. 2026-04-16T14:35:00+0200 */
  scheduled: string
  /** Predicted departure (from prognosis); falls back to scheduled */
  expected: string
}

interface OdchLocationResult {
  stations: Array<{ id: string | number; name: string } | null>
}

interface OdchStationboardResult {
  station?: { id: string; name: string }
  stationboard: Array<{
    category: string
    name: string      // display name e.g. "T 3"
    number: string    // may be service/trip number — prefer parsing from `name`
    to: string
    stop: {
      departure: string | null
      platform: string | null
      prognosis?: { departure?: string | null }
    }
  }>
}

/** Search for stations matching a query string. */
export async function searchStations(q: string): Promise<Array<{ id: string; name: string }>> {
  const url = `${BASE}/locations?query=${encodeURIComponent(q)}&limit=10`
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`Locations API ${res.status}`)
  const data: OdchLocationResult = await res.json()
  return (data.stations ?? [])
    .filter((s): s is { id: string | number; name: string } => Boolean(s?.id && s?.name))
    .map(s => ({ id: String(s.id), name: s.name }))
}

/** Fetch all departures for a single stop, optionally filtered to trams only. */
export async function getStationboardTrams(stopId: string, limit = 20, tramOnly = true): Promise<TramDeparture[]> {
  const params = new URLSearchParams({
    station: stopId,
    limit:   String(limit),
  })
  if (tramOnly) params.append('transportations[]', 'tram')
  const url = `${BASE}/stationboard?${params}`
  let res: Response
  try {
    res = await fetch(url, { headers: UA, cache: 'no-store' })
  } catch (err) {
    console.error(`transport: fetch failed for stop ${stopId}:`, err)
    return []
  }
  if (!res.ok) {
    console.error(`transport: stationboard HTTP ${res.status} for stop ${stopId}`)
    return []
  }
  const data: OdchStationboardResult = await res.json()
  const stopName = data.station?.name ?? stopId

  return (data.stationboard ?? [])
    .filter(d => {
      if (!tramOnly) return true
      const cat = String(d.category ?? '').trim().toLowerCase()
      return cat === 't' || cat === 'tram' || cat === 'tramway'
    })
    .map(d => {
      // API changed: `name` is now a trip ID (e.g. "009810"), `number` is the line number (e.g. "2").
      const sched = fixIsoOffset(d.stop?.departure ?? '')
      const prog  = fixIsoOffset(d.stop?.prognosis?.departure ?? '')
      return {
        stop_id:   stopId,
        stop_name: stopName,
        line:      d.number || '',
        direction: d.to ?? '',
        category:  String(d.category ?? '').trim().toLowerCase(),
        scheduled: sched,
        expected:  prog || sched,
      }
    })
    .filter(d => d.scheduled)
}

/** Fetch all upcoming departures for configured stops (no tram-only filter —
 *  the user already chose these stops explicitly as tram stops). */
export async function getUpcomingTrams(stopIds: string[]): Promise<TramDeparture[]> {
  const results = await Promise.all(stopIds.map(id => getStationboardTrams(id, 20, false)))
  return results.flat().sort(
    (a, b) => new Date(a.expected).getTime() - new Date(b.expected).getTime()
  )
}

/**
 * Find the tram departure closest to `ts` within ±windowSec seconds.
 * Returns null if none found.
 */
export function findTramAtTime(
  trams: TramDeparture[],
  ts: Date,
  windowSec = 90
): TramDeparture | null {
  const tsMs = ts.getTime()
  let best: TramDeparture | null = null
  let bestDiff = Infinity

  for (const t of trams) {
    const depMs = new Date(t.expected).getTime()
    const diff = Math.abs(depMs - tsMs)
    if (diff <= windowSec * 1000 && diff < bestDiff) {
      bestDiff = diff
      best = t
    }
  }
  return best
}

/**
 * transport.opendata.ch returns timestamps like "2026-04-16T14:35:00+0200"
 * (no colon in timezone offset). Convert to proper ISO 8601 for Date parsing.
 */
function fixIsoOffset(s: string): string {
  if (!s) return ''
  return s.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3')
}
