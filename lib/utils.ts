import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Format dB value for display
export function formatDb(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined) return '—'
  return `${value.toFixed(decimals)} dB`
}

// Format timestamp in Europe/Zurich timezone
export function formatZurichTime(
  ts: string | Date,
  format: 'time' | 'datetime' | 'date' = 'time'
): string {
  const date = typeof ts === 'string' ? new Date(ts) : ts
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Europe/Zurich',
    ...(format === 'time' && { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    ...(format === 'datetime' && {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }),
    ...(format === 'date' && { year: 'numeric', month: '2-digit', day: '2-digit' }),
  }
  return new Intl.DateTimeFormat('de-CH', options).format(date)
}

// Leq calculation from array of linear dB values
export function computeLeq(dbValues: number[]): number | null {
  if (dbValues.length === 0) return null
  const sumLinear = dbValues.reduce((sum, db) => sum + Math.pow(10, db / 10), 0)
  return 10 * Math.log10(sumLinear / dbValues.length)
}

// Percentile from sorted array
export function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))]
}

// Validate that a string is a valid ISO8601 timestamp
export function isValidIso(ts: string): boolean {
  const d = new Date(ts)
  return !isNaN(d.getTime())
}

// Clamp a number between min and max
export function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val))
}

// Color for dB value relative to limit
export function dbColor(db: number, limit: number): string {
  if (db < limit - 5) return '#22c55e' // green — well within limits
  if (db < limit) return '#F59E0B'     // amber — approaching
  return '#ef4444'                      // red — over limit
}
