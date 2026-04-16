'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  ComposedChart,
  Line,
  ReferenceLine,
  ReferenceArea,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { formatZurichTime } from '@/lib/utils'
import { NOISE_LIMITS } from '@/lib/db'

interface Reading {
  ts: string
  db_cal: number | null
  tram_flag?: boolean
  tram_line?: string | null
  tram_dir?: string | null
}

interface ChartPoint {
  ts: string
  label: string
  ext: number | null
  int: number | null
  tram_flag: boolean
  tram_line: string | null
}

// Build tram event bands from the reading stream
function extractTramBands(points: ChartPoint[]): Array<{ x1: string; x2: string; line: string | null }> {
  const bands: Array<{ x1: string; x2: string; line: string | null }> = []
  let inBand = false
  let bandStart = ''
  let bandLine: string | null = null

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p.tram_flag && !inBand) {
      inBand = true
      bandStart = p.ts
      bandLine = p.tram_line
    } else if (!p.tram_flag && inBand) {
      bands.push({ x1: bandStart, x2: points[i - 1]?.ts ?? bandStart, line: bandLine })
      inBand = false
    }
  }
  if (inBand && points.length > 0) {
    bands.push({ x1: bandStart, x2: points[points.length - 1].ts, line: bandLine })
  }
  return bands
}

const WINDOW_MS = 5 * 60 * 1000 // 5-minute rolling window

export function LiveChart() {
  const [points, setPoints] = useState<ChartPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Determine day/night limit
  const now = new Date()
  const zurichHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', hour: 'numeric', hour12: false }).format(now)
  )
  const isNight = zurichHour < 6 || zurichHour >= 22
  const limit = isNight ? NOISE_LIMITS.night : NOISE_LIMITS.day

  const lastFetchedRef = useRef<{ ext: number; int: number }>({ ext: 0, int: 0 })

  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch('/api/live')
      if (!res.ok) { setError('Failed to fetch live data'); return }
      const data: { exterior: Reading[]; interior: Reading[] } = await res.json()

      const nowMs = Date.now()
      const cutoff = new Date(nowMs - WINDOW_MS).toISOString()

      // Merge exterior + interior readings by timestamp
      const extMap = new Map<string, Reading>()
      for (const r of data.exterior) {
        extMap.set(r.ts, r)
      }
      const intMap = new Map<string, Reading>()
      for (const r of data.interior) {
        intMap.set(r.ts, r)
      }

      // All timestamps from both sources
      const allTs = Array.from(new Set([...Array.from(extMap.keys()), ...Array.from(intMap.keys())]))
        .filter(ts => ts >= cutoff)
        .sort()

      const newPoints: ChartPoint[] = allTs.map(ts => {
        const ext = extMap.get(ts)
        const int = intMap.get(ts)
        return {
          ts,
          label: formatZurichTime(ts, 'time'),
          ext: ext?.db_cal ?? null,
          int: int?.db_cal ?? null,
          tram_flag: ext?.tram_flag ?? false,
          tram_line: ext?.tram_line ?? null,
        }
      })

      setPoints(newPoints)
      setLoading(false)
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    fetchLive()
    const interval = setInterval(fetchLive, 2000)
    return () => clearInterval(interval)
  }, [fetchLive])

  if (loading) return <Skeleton className="w-full h-64" />
  if (error) return (
    <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
      {error}
    </div>
  )

  const tramBands = extractTramBands(points)

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(216 34% 17%)" />
          <XAxis
            dataKey="label"
            tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={[30, 90]}
            tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `${v}`}
            width={36}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(224 71% 7%)',
              border: '1px solid hsl(216 34% 17%)',
              borderRadius: '6px',
              fontSize: '12px',
            }}
            labelStyle={{ color: 'hsl(213 31% 91%)' }}
            formatter={(value: number, name: string) => [
              `${value?.toFixed(1)} dB(A)`,
              name === 'ext' ? 'Exterior' : 'Interior',
            ]}
          />
          <Legend
            formatter={v => v === 'ext' ? 'Exterior' : 'Interior'}
            wrapperStyle={{ fontSize: '12px', color: 'hsl(215 20% 55%)' }}
          />

          {/* Tram event bands */}
          {tramBands.map((band, i) => (
            <ReferenceArea
              key={i}
              x1={formatZurichTime(band.x1, 'time')}
              x2={formatZurichTime(band.x2, 'time')}
              fill="hsl(43 100% 50% / 0.12)"
              stroke="hsl(43 100% 50% / 0.3)"
              strokeWidth={1}
              label={{
                value: `T${band.line ?? ''}`,
                position: 'top',
                fill: 'hsl(43 100% 60%)',
                fontSize: 10,
              }}
            />
          ))}

          {/* ES II limit line */}
          <ReferenceLine
            y={limit}
            stroke="#ef4444"
            strokeDasharray="6 3"
            strokeWidth={1.5}
            label={{
              value: `ES II ${isNight ? 'night' : 'day'} ${limit} dB`,
              position: 'right',
              fill: '#ef4444',
              fontSize: 10,
            }}
          />

          <Line
            type="monotoneX"
            dataKey="ext"
            stroke="#F59E0B"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            type="monotoneX"
            dataKey="int"
            stroke="#60A5FA"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
