'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  ComposedChart,
  BarChart,
  Bar,
  Line,
  ReferenceArea,
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
import { NOISE_LIMITS } from '@/lib/utils'
import { Download, RefreshCw, AlertTriangle } from 'lucide-react'

const SOURCE_COLORS = ['#F59E0B', '#60A5FA', '#34D399', '#F87171', '#A78BFA', '#FB923C']

interface RawReading { ts: string; source: string; db_cal: number; tram_flag: boolean }
interface HourPoint { bucket: string; source: string; leq: number; l_peak: number; event_count: number; n: number }
interface DayPoint  { bucket: string; source: string; leq: number; n: number }

type Resolution = 'minute' | 'hour' | 'day'

interface MinutePoint {
  label: string   // formatted time — X-axis key (string so tsMs never contaminates Y scale)
  tsMs: number    // kept for tram-band mapping but NOT in the Recharts data array
  [source: string]: number | string
}

function toMinuteChart(raw: RawReading[]): { points: MinutePoint[]; msIndex: MinutePoint[] } {
  const map = new Map<number, MinutePoint>()
  for (const r of raw) {
    const ms = new Date(r.ts).getTime()
    if (!map.has(ms)) map.set(ms, { label: formatZurichTime(r.ts, 'time'), tsMs: ms })
    map.get(ms)![r.source] = r.db_cal
  }
  const points = Array.from(map.values()).sort((a, b) => a.tsMs - b.tsMs)
  return { points, msIndex: points }
}

function computeTramBands(raw: RawReading[], msIndex: MinutePoint[]) {
  const msSet = new Set(raw.filter(r => r.tram_flag).map(r => new Date(r.ts).getTime()))
  const sorted = Array.from(msSet).sort((a, b) => a - b)
  // Collect contiguous ms windows
  const msBands: { x1: number; x2: number }[] = []
  let start = -1, prev = -1
  for (const ms of sorted) {
    if (start === -1) { start = ms; prev = ms; continue }
    if (ms - prev > 5000) { msBands.push({ x1: start, x2: prev }); start = ms }
    prev = ms
  }
  if (start !== -1) msBands.push({ x1: start, x2: prev })
  // Map ms → label strings used by the category XAxis
  return msBands.map(b => {
    const p1 = msIndex.find(p => p.tsMs >= b.x1)
    const p2 = [...msIndex].reverse().find(p => p.tsMs <= b.x2)
    if (!p1 || !p2) return null
    return { x1: p1.label, x2: p2.label }
  }).filter((b): b is { x1: string; x2: string } => b !== null)
}

function toAggChart(points: Array<HourPoint | DayPoint>, resolution: 'hour' | 'day') {
  const map = new Map<string, Record<string, number | string>>()
  for (const row of points) {
    const ts = row.bucket
    if (!map.has(ts)) {
      map.set(ts, {
        ts,
        label: resolution === 'day' ? formatZurichTime(ts, 'date') : formatZurichTime(ts, 'datetime'),
      })
    }
    map.get(ts)![row.source + '_leq'] = row.leq
    if ('l_peak' in row) map.get(ts)![row.source + '_peak'] = row.l_peak
  }
  const sorted = Array.from(map.values()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  // Insert null sentinels at gaps
  const gapMs = resolution === 'hour' ? 3 * 3600_000 : 2 * 86_400_000
  const out: typeof sorted = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].ts && sorted[i - 1].ts) {
      const diff = new Date(String(sorted[i].ts)).getTime() - new Date(String(sorted[i - 1].ts)).getTime()
      if (diff > gapMs) out.push({ ts: '', label: '' })
    }
    out.push(sorted[i])
  }
  return out
}

export default function HistoryPage() {
  const now     = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000)

  const [from, setFrom]             = useState(weekAgo.toISOString().substring(0, 10))
  const [to, setTo]                 = useState(now.toISOString().substring(0, 10))
  const [resolution, setResolution] = useState<Resolution>('hour')
  const [rawData, setRawData]       = useState<RawReading[]>([])
  const [capped, setCapped]         = useState(false)
  const [hourPoints, setHourPoints] = useState<HourPoint[]>([])
  const [dayPoints, setDayPoints]   = useState<DayPoint[]>([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fromIso = new Date(from + 'T00:00:00').toISOString()
      const toIso   = new Date(to   + 'T23:59:59').toISOString()
      const res = await fetch(
        `/api/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&resolution=${resolution}`
      )
      if (!res.ok) throw new Error('Failed to load history')
      const data = await res.json()

      if (resolution === 'minute') {
        setRawData((data.raw as RawReading[]) ?? [])
        setCapped(!!data.capped)
      } else if (resolution === 'hour') {
        setHourPoints((data.points as HourPoint[]) ?? [])
      } else {
        setDayPoints((data.points as DayPoint[]) ?? [])
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [from, to, resolution])

  useEffect(() => { fetchData() }, [fetchData])

  const { points: minutePoints, msIndex } = useMemo(() => toMinuteChart(rawData), [rawData])
  const tramBands = useMemo(() => computeTramBands(rawData, msIndex), [rawData, msIndex])
  const hourChart    = useMemo(() => toAggChart(hourPoints, 'hour'), [hourPoints])
  const dayChart     = useMemo(() => toAggChart(dayPoints, 'day'), [dayPoints])

  const sources = useMemo(() => {
    if (resolution === 'minute') return Array.from(new Set(rawData.map(r => r.source))).sort()
    const pts = resolution === 'hour' ? hourPoints : dayPoints
    return Array.from(new Set(pts.map(r => r.source))).sort()
  }, [resolution, rawData, hourPoints, dayPoints])

  const downloadCsv = () => {
    let csv = ''
    if (resolution === 'minute') {
      csv = 'timestamp,source,db_cal,tram_flag\n' +
        rawData.map(r => `${r.ts},${r.source},${r.db_cal.toFixed(2)},${r.tram_flag}`).join('\n')
    } else if (resolution === 'hour') {
      csv = 'bucket,source,leq,l_peak,event_count,n\n' +
        hourPoints.map(r => `${r.bucket},${r.source},${r.leq.toFixed(2)},${r.l_peak.toFixed(2)},${r.event_count},${r.n}`).join('\n')
    } else {
      csv = 'bucket,source,leq,n\n' +
        dayPoints.map(r => `${r.bucket},${r.source},${r.leq.toFixed(2)},${r.n}`).join('\n')
    }
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `tramwatch-${from}-${to}-${resolution}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  const chartStyle = {
    contentStyle: {
      backgroundColor: 'hsl(224 71% 7%)',
      border: '1px solid hsl(216 34% 17%)',
      borderRadius: '6px',
      fontSize: '12px',
    },
    axisProps: {
      tick: { fill: 'hsl(215 20% 55%)', fontSize: 11 },
      tickLine: false as const,
      axisLine: false as const,
    },
    grid: { strokeDasharray: '3 3', stroke: 'hsl(216 34% 17%)' },
  }

  const isEmpty = resolution === 'minute' ? rawData.length === 0
    : resolution === 'hour' ? hourPoints.length === 0 : dayPoints.length === 0

  return (
    <div className="p-4 space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-foreground">History</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" value={from} max={to}
            onChange={e => setFrom(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" />
          <span className="text-muted-foreground text-sm">to</span>
          <input type="date" value={to} min={from} max={new Date().toISOString().substring(0, 10)}
            onChange={e => setTo(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" />
        </div>

        <div className="flex rounded-md border border-input overflow-hidden">
          {(['minute', 'hour', 'day'] as Resolution[]).map(r => (
            <button key={r} onClick={() => setResolution(r)}
              className={`px-3 py-1.5 text-sm transition-colors ${
                resolution === r ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}>
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>

        <Button size="sm" variant="outline" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
        <Button size="sm" variant="outline" onClick={downloadCsv} disabled={isEmpty}>
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-destructive/20 text-destructive text-sm">{error}</div>
      )}

      {/* ── Minute view: oscilloscope ── */}
      {resolution === 'minute' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              Raw 1-second readings
              {capped && (
                <span className="flex items-center gap-1 text-amber-400 text-xs">
                  <AlertTriangle className="h-3 w-3" />
                  Capped at 7200 s — narrow your date range to see a full window
                </span>
              )}
              {!loading && !isEmpty && (
                <span className="text-xs text-muted-foreground/60 ml-auto">
                  {rawData.length} pts · {tramBands.length} tram passages
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-72 w-full" /> : isEmpty ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No data in this range.</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={minutePoints} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid {...chartStyle.grid} />
                  <XAxis
                    dataKey="label"
                    {...chartStyle.axisProps}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    domain={[20, 'auto']}
                    allowDataOverflow={false}
                    tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                  />
                  <Tooltip
                    contentStyle={chartStyle.contentStyle}
                    formatter={(v: number) => [`${v?.toFixed(1)} dB(A)`]}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <ReferenceLine y={NOISE_LIMITS.day}   stroke="#ef4444" strokeDasharray="6 3" label={{ value: `Day ${NOISE_LIMITS.day}dB`, position: 'right', fill: '#ef4444', fontSize: 10 }} />
                  <ReferenceLine y={NOISE_LIMITS.night} stroke="#f97316" strokeDasharray="6 3" label={{ value: `Night ${NOISE_LIMITS.night}dB`, position: 'right', fill: '#f97316', fontSize: 10 }} />
                  {tramBands.map((b, i) => (
                    <ReferenceArea key={i} x1={b.x1} x2={b.x2} fill="rgba(245,158,11,0.12)" strokeOpacity={0} />
                  ))}
                  {sources.map((src, i) => (
                    <Line key={src} type="monotone" dataKey={src} name={src}
                      stroke={SOURCE_COLORS[i % SOURCE_COLORS.length]}
                      strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Hour view: leq + peak chart + stats table ── */}
      {resolution === 'hour' && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Leq &amp; L_peak per hour
                <span className="ml-2 text-xs text-muted-foreground/60">(solid = Leq, dashed = L_peak)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton className="h-64 w-full" /> : isEmpty ? (
                <p className="text-sm text-muted-foreground py-8 text-center">No data in this range.</p>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={hourChart} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid {...chartStyle.grid} />
                    <XAxis dataKey="label" {...chartStyle.axisProps} interval="preserveStartEnd" />
                    <YAxis
                      domain={[20, 'auto']}
                      allowDataOverflow={false}
                      tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={36}
                    />
                    <Tooltip
                      contentStyle={chartStyle.contentStyle}
                      formatter={(v: number) => [`${v?.toFixed(1)} dB(A)`]}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <ReferenceLine y={NOISE_LIMITS.day}   stroke="#ef4444" strokeDasharray="6 3" label={{ value: `Day ${NOISE_LIMITS.day}dB`, position: 'right', fill: '#ef4444', fontSize: 10 }} />
                    <ReferenceLine y={NOISE_LIMITS.night} stroke="#f97316" strokeDasharray="6 3" label={{ value: `Night ${NOISE_LIMITS.night}dB`, position: 'right', fill: '#f97316', fontSize: 10 }} />
                    {sources.map((src, i) => {
                      const color = SOURCE_COLORS[i % SOURCE_COLORS.length]
                      return [
                        <Line key={src + '_leq'}  type="monotone" dataKey={src + '_leq'}  name={`${src} Leq`}    stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />,
                        <Line key={src + '_peak'} type="monotone" dataKey={src + '_peak'} name={`${src} L_peak`} stroke={color} strokeWidth={1}   dot={false} isAnimationActive={false} connectNulls strokeDasharray="4 2" />,
                      ]
                    })}
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Hour stats table */}
          {!loading && !isEmpty && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Hourly breakdown
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Hour</th>
                        <th className="text-left py-2 pr-3 text-muted-foreground font-medium">Source</th>
                        <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Leq</th>
                        <th className="text-right py-2 pr-4 text-muted-foreground font-medium">L_peak</th>
                        <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Events</th>
                        <th className="text-right py-2 text-muted-foreground font-medium">Readings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hourPoints.map((row, i) => (
                        <tr key={i} className="border-b border-border/50 hover:bg-accent/30">
                          <td className="py-1.5 pr-4 text-xs text-muted-foreground font-mono">
                            {formatZurichTime(row.bucket, 'datetime')}
                          </td>
                          <td className="py-1.5 pr-3 font-medium text-amber-400 text-xs">{row.source}</td>
                          <td className="py-1.5 pr-4 text-right font-mono text-xs">{row.leq.toFixed(1)} dB</td>
                          <td className="py-1.5 pr-4 text-right font-mono text-xs">{row.l_peak.toFixed(1)} dB</td>
                          <td className="py-1.5 pr-4 text-right font-mono text-xs">{row.event_count}</td>
                          <td className="py-1.5 text-right font-mono text-xs text-muted-foreground">{row.n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ── Day view: compliance bar chart ── */}
      {resolution === 'day' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Daily Leq — LSV ES II compliance
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-64 w-full" /> : isEmpty ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No data in this range.</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={dayChart} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid {...chartStyle.grid} />
                  <XAxis dataKey="label" {...chartStyle.axisProps} interval="preserveStartEnd" />
                  <YAxis
                    domain={[20, 'auto']}
                    allowDataOverflow={false}
                    tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                  />
                  <Tooltip
                    contentStyle={chartStyle.contentStyle}
                    formatter={(v: number) => [`${v?.toFixed(1)} dB(A)`]}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <ReferenceLine y={NOISE_LIMITS.day}   stroke="#ef4444" strokeDasharray="6 3" label={{ value: `Day ${NOISE_LIMITS.day}dB`, position: 'right', fill: '#ef4444', fontSize: 10 }} />
                  <ReferenceLine y={NOISE_LIMITS.night} stroke="#f97316" strokeDasharray="6 3" label={{ value: `Night ${NOISE_LIMITS.night}dB`, position: 'right', fill: '#f97316', fontSize: 10 }} />
                  {sources.map((src, i) => (
                    <Bar key={src} dataKey={src + '_leq'} name={src}
                      fill={SOURCE_COLORS[i % SOURCE_COLORS.length]}
                      fillOpacity={0.8} maxBarSize={40} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
