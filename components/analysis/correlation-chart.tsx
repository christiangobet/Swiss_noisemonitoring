'use client'

import {
  ComposedChart, Line, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { formatZurichTime } from '@/lib/utils'

const SOURCE_COLORS = ['#F59E0B', '#60A5FA', '#34D399', '#F87171', '#A78BFA', '#FB923C']
const LINE_COLORS: Record<string, string> = { '2': '#f59e0b', '3': '#60a5fa' }
const DEFAULT_LINE_COLOR = '#a78bfa'

export interface HourPoint {
  bucket: string
  source: string
  leq: number
}

export interface TramEvent {
  ts: string
  line: string
  direction: string
}

export interface TramLineOffset {
  line: string
  direction: string
  offset_sec: number
}

interface ChartPoint {
  tsMs: number
  [source: string]: number
}

interface Props {
  hourPoints: HourPoint[]
  tramEvents: TramEvent[]
  offsets: TramLineOffset[]
  activeSourceNames: string[]
  showTramMarkers: boolean
}

export default function CorrelationChart({
  hourPoints,
  tramEvents,
  offsets,
  activeSourceNames,
  showTramMarkers,
}: Props) {
  const bucketMap = new Map<number, ChartPoint>()
  for (const p of hourPoints) {
    if (!activeSourceNames.includes(p.source)) continue
    const tsMs = new Date(p.bucket).getTime()
    if (!bucketMap.has(tsMs)) bucketMap.set(tsMs, { tsMs })
    bucketMap.get(tsMs)![p.source] = p.leq
  }
  const data = Array.from(bucketMap.values()).sort((a, b) => a.tsMs - b.tsMs)

  const offsetMap = new Map<string, number>(
    offsets.map(o => [`${o.line}|${o.direction}`, o.offset_sec])
  )

  const markers = showTramMarkers
    ? tramEvents.map(e => ({
        tsMs: new Date(e.ts).getTime() + (offsetMap.get(`${e.line}|${e.direction}`) ?? 0) * 1000,
        line: e.line,
      }))
    : []

  const xMin = data[0]?.tsMs
  const xMax = data[data.length - 1]?.tsMs

  return (
    <ResponsiveContainer width="100%" height={380}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="tsMs"
          type="number"
          scale="time"
          domain={[xMin ?? 'auto', xMax ?? 'auto']}
          tickFormatter={ms => formatZurichTime(new Date(ms).toISOString())}
          tick={{ fontSize: 11, fill: '#9ca3af' }}
          tickCount={6}
        />
        <YAxis
          domain={[30, 80]}
          tick={{ fontSize: 11, fill: '#9ca3af' }}
          label={{
            value: 'dB(A)',
            angle: -90,
            position: 'insideLeft',
            offset: 10,
            style: { fontSize: 11, fill: '#9ca3af' },
          }}
        />
        <Tooltip
          labelFormatter={ms =>
            new Date(ms as number).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })
          }
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 6 }}
          itemStyle={{ color: '#e5e7eb', fontSize: 12 }}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />

        {activeSourceNames.map((src, i) => (
          <Line
            key={src}
            dataKey={src}
            stroke={SOURCE_COLORS[i % SOURCE_COLORS.length]}
            dot={false}
            strokeWidth={1.5}
            connectNulls
            isAnimationActive={false}
          />
        ))}

        {markers.map((m, i) => (
          <ReferenceLine
            key={i}
            x={m.tsMs}
            stroke={LINE_COLORS[m.line] ?? DEFAULT_LINE_COLOR}
            strokeDasharray="4 4"
            strokeWidth={1}
            strokeOpacity={0.55}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
