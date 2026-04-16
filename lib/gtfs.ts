/**
 * GTFS parsing utilities for VBZ (Zürich) static feed.
 * Parses CSV files from the downloaded ZIP without third-party CSV libs.
 */

export interface GtfsStop {
  stop_id: string
  stop_name: string
  stop_lat: number
  stop_lon: number
}

export interface GtfsRoute {
  route_id: string
  route_short_name: string
  route_type: number
}

export interface GtfsTrip {
  route_id: string
  service_id: string
  trip_id: string
  trip_headsign: string
  direction_id: number
  shape_id: string | null
}

export interface GtfsStopTime {
  trip_id: string
  arrival_time: string
  departure_time: string
  stop_id: string
  stop_sequence: number
}

export interface GtfsCalendar {
  service_id: string
  monday: boolean
  tuesday: boolean
  wednesday: boolean
  thursday: boolean
  friday: boolean
  saturday: boolean
  sunday: boolean
  start_date: string
  end_date: string
}

// Parse a simple CSV string (handles quoted fields)
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []

  const headers = parsecsv_line(lines[0])
  return lines.slice(1).map(line => {
    const values = parsecsv_line(line)
    const record: Record<string, string> = {}
    headers.forEach((h, i) => {
      record[h.trim()] = (values[i] ?? '').trim()
    })
    return record
  })
}

function parsecsv_line(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

// VBZ GTFS static feed URL (Zürich open data portal)
export const VBZ_GTFS_URL =
  'https://data.stadt-zuerich.ch/dataset/vbz_fahrplandaten_gtfs/download/OGDS-VBZ-GTFS.zip'

// Filter for tram route types (GTFS route_type 0 = tram)
export function isTramRoute(routeType: number): boolean {
  return routeType === 0
}
