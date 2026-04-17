'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatZurichTime } from '@/lib/utils'
import { NOISE_LIMITS } from '@/lib/db'
import { Download, RefreshCw } from 'lucide-react'

interface Reading {
  ts: string
  source: string
  db_cal: number | null
}

interface TramEvent {
  event_id: number
  started_at: string
  ended_at: string
  tram_line: string | null
  tram_dir: string | null
  peak_db_ext: number | null
  mean_db_ext: number | null
  delta_bg_db: number | null
}

interface ChartPoint {
  label: string
  ts: string
  [source: string]: string | number | null
}

type Resolution = 'minute' | 'hour' | 'day'

function truncateByResolution(ts: string, res: Resolution): string {
  const d = new Date(ts)
  if (res === 'minute') {
    d.setSeconds(0, 0)
  } else if (res === 'hour') {
    d.setMinutes(0, 0, 0)
  } else {
    d.setHours(0, 0, 0, 0)
  }
  return d.toISOString()
}

export default function HistoryPage() {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000)

  const [from, setFrom] = useState(weekAgo.toISOString().substring(0, 10))
  const [to, setTo] = useState(now.toISOString().substring(0, 10))
  const [resolution, setResolution] = useState<Resolution>('hour')
  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [tramEvents, setTramEvents] = useState<TramEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fromIso = new Date(from + 'T00:00:00').toISOString()
      const toIso = new Date(to + 'T23:59:59').toISOString()

      const [readRes, tramRes] = await Promise.all([
        fetch(`/api/readings?source=both&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&limit=1000`),
        fetch(`/api/tram-events?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
      ])

      if (!readRes.ok) throw new Error('Failed to load readings')
      const readData: { readings: Reading[] } = await readRes.json()

      if (tramRes.ok) {
        const tramData: { events: TramEvent[] } = await tramRes.json()
        setTramEvents(tramData.events)
      }

      // Aggregate by resolution per source
      const buckets = new Map<string, Map<string, { linear: number; count: number }>>()
      for (const r of readData.readings) {
        if (r.db_cal == null) continue
        const bucket = truncateByResolution(r.ts, resolution)
        if (!buckets.has(bucket)) buckets.set(bucket, new Map())
        const srcMap = buckets.get(bucket)!
        if (!srcMap.has(r.source)) srcMap.set(r.source, { linear: 0, count: 0 })
        const b = srcMap.get(r.source)!
        b.linear += Math.pow(10, r.db_cal / 10)
        b.count++
      }

      const points: ChartPoint[] = Array.from(buckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ts, srcMap]) => {
          const pt: ChartPoint = {
            ts,
            label: resolution === 'day' ? formatZurichTime(ts, 'date') : formatZurichTime(ts, 'datetime'),
          }
          srcMap.forEach(({ linear, count }, src) => {
            pt[src] = linear > 0 ? 10 * Math.log10(linear / count) : null
          })
          return pt
        })

      setChartData(points)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [from, to, resolution])

  useEffect(() => { fetchData() }, [fetchData])

  const downloadCsv = () => {
    const srcKeys = Array.from(new Set(chartData.flatMap(p => Object.keys(p).filter(k => k !== 'ts' && k !== 'label')))).sort()
    const header = ['timestamp', ...srcKeys].join(',') + '\n'
    const rows = chartData.map(p =>
      [p.ts, ...srcKeys.map(k => typeof p[k] === 'number' ? (p[k] as number).toFixed(2) : '')].join(',')
    ).join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tramwatch-${from}-${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-foreground">History</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={from}
            max={to}
            onChange={e => setFrom(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          />
          <span className="text-muted-foreground text-sm">to</span>
          <input
            type="date"
            value={to}
            min={from}
            max={new Date().toISOString().substring(0, 10)}
            onChange={e => setTo(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          />
        </div>

        <div className="flex rounded-md border border-input overflow-hidden">
          {(['minute', 'hour', 'day'] as Resolution[]).map(r => (
            <button
              key={r}
              onClick={() => setResolution(r)}
              className={`px-3 py-1.5 text-sm transition-colors ${
                resolution === r
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50'
              }`}
            >
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>

        <Button size="sm" variant="outline" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
        <Button size="sm" variant="outline" onClick={downloadCsv} disabled={chartData.length === 0}>
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-destructive/20 text-destructive text-sm">{error}</div>
      )}

      {/* Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Leq ({resolution})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
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
                  width={36}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(224 71% 7%)',
                    border: '1px solid hsl(216 34% 17%)',
                    borderRadius: '6px',
                    fontSize: '12px',
                  }}
                  formatter={(v: number) => [`${v?.toFixed(1)} dB(A)`]}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <ReferenceLine y={NOISE_LIMITS.day} stroke="#ef4444" strokeDasharray="6 3" label={{ value: `Day ${NOISE_LIMITS.day}dB`, position: 'right', fill: '#ef4444', fontSize: 10 }} />
                <ReferenceLine y={NOISE_LIMITS.night} stroke="#f97316" strokeDasharray="6 3" label={{ value: `Night ${NOISE_LIMITS.night}dB`, position: 'right', fill: '#f97316', fontSize: 10 }} />
                {Array.from(new Set(chartData.flatMap(p => Object.keys(p).filter(k => k !== 'ts' && k !== 'label')))).sort().map((src, i) => {
                  const colors = ['#F59E0B', '#60A5FA', '#34D399', '#F87171', '#A78BFA', '#FB923C']
                  return <Line key={src} type="monotone" dataKey={src} name={src} stroke={colors[i % colors.length]} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                })}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Tram events table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Tram Events ({tramEvents.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tramEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tram events in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Time</th>
                    <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Line</th>
                    <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Direction</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Peak dB</th>
                    <th className="text-right py-2 text-muted-foreground font-medium">Δ Background</th>
                  </tr>
                </thead>
                <tbody>
                  {tramEvents.map(ev => (
                    <tr key={ev.event_id} className="border-b border-border/50 hover:bg-accent/30">
                      <td className="py-2 pr-4 font-db text-xs text-muted-foreground">
                        {formatZurichTime(ev.started_at, 'datetime')}
                      </td>
                      <td className="py-2 pr-4 font-semibold text-amber-400">
                        {ev.tram_line ?? '—'}
                      </td>
                      <td className="py-2 pr-4 text-foreground">{ev.tram_dir ?? '—'}</td>
                      <td className="py-2 pr-4 text-right font-db">
                        {ev.peak_db_ext?.toFixed(1) ?? '—'} dB
                      </td>
                      <td className="py-2 text-right font-db">
                        {ev.delta_bg_db?.toFixed(1) ?? '—'} dB
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
