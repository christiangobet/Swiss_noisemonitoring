'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  ComposedChart,
  Line,
  ReferenceLine,
  ReferenceArea,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { formatZurichTime } from '@/lib/utils'
import { NOISE_LIMITS } from '@/lib/db'

interface Reading {
  ts: string
  db_cal: number | null
}

interface ChartPoint {
  tsMs: number
  ext: number | null
  int: number | null
}

interface TramDep {
  line: string
  direction: string
  expected: string
}

// ── Line colour palette ───────────────────────────────────────────────────────
const LINE_COLORS: Record<string, string> = {
  '2':  '#f97316',
  '3':  '#ef4444',
  '4':  '#8b5cf6',
  '5':  '#06b6d4',
  '6':  '#22c55e',
  '7':  '#a855f7',
  '8':  '#3b82f6',
  '9':  '#eab308',
  '10': '#14b8a6',
  '11': '#ec4899',
  '12': '#84cc16',
  '13': '#f43f5e',
  '14': '#64748b',
  '15': '#d97706',
}
function lineColor(line: string) {
  return LINE_COLORS[line] ?? '#94a3b8'
}
function withAlpha(hex: string, a: number) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

const HISTORY_MS  = 5 * 60 * 1000  // 5 min of history
const FUTURE_MS   = 3 * 60 * 1000  // 3 min of future (show upcoming trams)
const TRAM_PAD_MS = 15 * 1000      // ±15 s band around each departure

export function LiveChart() {
  const [points,   setPoints]   = useState<ChartPoint[]>([])
  const [schedule, setSchedule] = useState<TramDep[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  // Day/night ES II limit
  const now          = new Date()
  const zurichHour   = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', hour: 'numeric', hour12: false }).format(now)
  )
  const isNight = zurichHour < 6 || zurichHour >= 22
  const limit   = isNight ? NOISE_LIMITS.night : NOISE_LIMITS.day

  // ── Fetch live noise readings ───────────────────────────────────────────────
  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch('/api/live')
      if (!res.ok) { setError('Failed to fetch live data'); return }
      const data: { exterior: Reading[]; interior: Reading[] } = await res.json()

      const nowMs  = Date.now()
      const cutoff = nowMs - HISTORY_MS

      const extMap = new Map<string, number>()
      for (const r of data.exterior) {
        if (r.db_cal !== null) extMap.set(r.ts, r.db_cal)
      }
      const intMap = new Map<string, number>()
      for (const r of data.interior) {
        if (r.db_cal !== null) intMap.set(r.ts, r.db_cal)
      }

      const allTs = Array.from(new Set([
        ...Array.from(extMap.keys()),
        ...Array.from(intMap.keys()),
      ])).filter(ts => new Date(ts).getTime() >= cutoff).sort()

      setPoints(allTs.map(ts => ({
        tsMs: new Date(ts).getTime(),
        ext:  extMap.get(ts) ?? null,
        int:  intMap.get(ts) ?? null,
      })))
      setLoading(false)
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  // ── Fetch tram schedule every 30 s ─────────────────────────────────────────
  const fetchSchedule = useCallback(async () => {
    try {
      const res = await fetch('/api/tram-schedule')
      if (res.ok) {
        const data = await res.json()
        setSchedule(data.departures ?? [])
      }
    } catch { /* non-fatal */ }
  }, [])

  useEffect(() => {
    fetchLive()
    fetchSchedule()
    const liveTimer     = setInterval(fetchLive,     2000)
    const scheduleTimer = setInterval(fetchSchedule, 30000)
    return () => { clearInterval(liveTimer); clearInterval(scheduleTimer) }
  }, [fetchLive, fetchSchedule])

  if (loading) return <Skeleton className="w-full h-64" />
  if (error) return (
    <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">{error}</div>
  )

  const nowMs      = Date.now()
  const domainMin  = nowMs - HISTORY_MS
  const domainMax  = nowMs + FUTURE_MS

  // Filter trams to those whose band overlaps the chart window
  const visibleTrams = schedule.filter(dep => {
    const ms = new Date(dep.expected).getTime()
    return ms + TRAM_PAD_MS >= domainMin && ms - TRAM_PAD_MS <= domainMax
  })

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={points} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(216 34% 17%)" />

          <XAxis
            dataKey="tsMs"
            type="number"
            scale="time"
            domain={[domainMin, domainMax]}
            tickCount={7}
            tickFormatter={ms => formatZurichTime(new Date(ms).toISOString(), 'time')}
            tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[30, 90]}
            tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `${v}`}
            width={32}
          />

          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(224 71% 7%)',
              border: '1px solid hsl(216 34% 17%)',
              borderRadius: '6px',
              fontSize: '12px',
            }}
            labelStyle={{ color: 'hsl(213 31% 91%)' }}
            labelFormatter={ms => formatZurichTime(new Date(ms as number).toISOString(), 'time')}
            formatter={(value: number, name: string) => [
              `${value?.toFixed(1)} dB(A)`,
              name === 'ext' ? 'Exterior' : 'Interior',
            ]}
          />

          {/* ── Scheduled tram bands ±15 s around each expected departure ── */}
          {visibleTrams.map((dep, i) => {
            const ms    = new Date(dep.expected).getTime()
            const color = lineColor(dep.line)
            // Shorten direction to first word to keep label compact
            const shortDir = dep.direction.split(' ')[0]
            return (
              <ReferenceArea
                key={`${dep.line}-${dep.expected}-${i}`}
                x1={ms - TRAM_PAD_MS}
                x2={ms + TRAM_PAD_MS}
                fill={withAlpha(color, 0.15)}
                stroke={withAlpha(color, 0.6)}
                strokeWidth={1}
                label={{
                  value: `${dep.line} ${shortDir}`,
                  position: 'insideTopLeft',
                  fill: color,
                  fontSize: 9,
                  fontWeight: 600,
                }}
              />
            )
          })}

          {/* ── ES II noise limit ── */}
          <ReferenceLine
            y={limit}
            stroke="#ef4444"
            strokeDasharray="6 3"
            strokeWidth={1.5}
            label={{
              value: `ES II ${limit} dB`,
              position: 'insideTopRight',
              fill: '#ef4444',
              fontSize: 10,
            }}
          />

          {/* ── Now marker ── */}
          <ReferenceLine
            x={nowMs}
            stroke="hsl(215 20% 45%)"
            strokeDasharray="3 3"
            strokeWidth={1}
          />

          <Line
            type="monotoneX"
            dataKey="ext"
            name="ext"
            stroke="#F59E0B"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            type="monotoneX"
            dataKey="int"
            name="int"
            stroke="#60A5FA"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 px-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-amber-400" /> Exterior
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-blue-400" /> Interior
        </span>
        {/* Show a swatch per unique line in the schedule */}
        {Array.from(new Set(schedule.map(d => d.line))).map(line => (
          <span key={line} className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-3 rounded-sm"
              style={{ backgroundColor: withAlpha(lineColor(line), 0.6) }}
            />
            Line {line}
          </span>
        ))}
      </div>
    </div>
  )
}
