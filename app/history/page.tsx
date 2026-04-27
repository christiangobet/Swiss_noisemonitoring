'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  ComposedChart, Line, ReferenceArea, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatZurichTime } from '@/lib/utils'
import { NOISE_LIMITS } from '@/lib/utils'
import { Download, RefreshCw, Zap, FileText, AlertTriangle } from 'lucide-react'

const SOURCE_COLORS = ['#F59E0B', '#60A5FA', '#34D399', '#F87171', '#A78BFA', '#FB923C']
const OUTLIER_DELTA = 8

interface HourPoint { bucket: string; source: string; leq: number; l_peak: number; event_count: number; n: number }
interface Passage {
  start_ts: string; end_ts: string; duration_sec: number
  peak_db: number; median_peak: number; is_outlier: boolean
}
interface StatsResponse {
  total_readings: number; coverage_pct: number
  tram_passages: number; median_passage_peak_db: number | null
  outlier_threshold_db: number | null; outlier_passages: number
  avg_background_db: number | null; worst_peak_db: number | null
  passages: Passage[]
}

export default function HistoryPage() {
  const now     = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000)

  const [from, setFrom]           = useState(weekAgo.toISOString().substring(0, 10))
  const [to, setTo]               = useState(now.toISOString().substring(0, 10))
  const [sources, setSources]     = useState<string[]>([])
  const [source, setSource]       = useState<string>('')
  const [hourPoints, setHourPoints] = useState<HourPoint[]>([])
  const [stats, setStats]         = useState<StatsResponse | null>(null)
  const [loading, setLoading]     = useState(false)
  const [detectLoading, setDetectLoading] = useState(false)
  const [detectResult, setDetectResult]   = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch(`/api/history?from=${encodeURIComponent(new Date(from + 'T00:00:00').toISOString())}&to=${encodeURIComponent(new Date(to + 'T23:59:59').toISOString())}&resolution=hour`)
      if (!res.ok) return
      const data = await res.json()
      const pts = (data.points ?? []) as HourPoint[]
      const unique = Array.from(new Set(pts.map((p: HourPoint) => p.source))).sort()
      setSources(unique)
    } catch { /* non-fatal */ }
  }, [from, to])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    setStats(null)
    try {
      const fromIso = new Date(from + 'T00:00:00').toISOString()
      const toIso   = new Date(to   + 'T23:59:59').toISOString()
      const srcParam = source ? `&source=${encodeURIComponent(source)}` : ''

      const histRes = await fetch(`/api/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&resolution=hour${srcParam}`)
      if (!histRes.ok) throw new Error('Failed to load history')
      const histData = await histRes.json()
      setHourPoints((histData.points ?? []) as HourPoint[])

      if (source) {
        const statsRes = await fetch(`/api/history/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&source=${encodeURIComponent(source)}`)
        if (statsRes.ok) setStats(await statsRes.json())
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [from, to, source])

  useEffect(() => { loadSources() }, [loadSources])
  useEffect(() => { fetchData() }, [fetchData])

  const handleRedetect = async () => {
    if (!source) return
    setDetectLoading(true)
    setDetectResult(null)
    try {
      const fromIso = new Date(from + 'T00:00:00').toISOString()
      const toIso   = new Date(to   + 'T23:59:59').toISOString()
      const res = await fetch('/api/admin/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromIso, to: toIso, source, dry_run: false }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Detection failed')
      setDetectResult(`Detection complete: ${data.passages_found} passages found, ${data.readings_flagged} readings flagged`)
      await fetchData()
    } catch (err) {
      setDetectResult(`Error: ${String(err)}`)
    } finally {
      setDetectLoading(false)
    }
  }

  const handleExportCsv = () => {
    const fromIso = new Date(from + 'T00:00:00').toISOString()
    const toIso   = new Date(to   + 'T23:59:59').toISOString()
    const srcParam = source ? `&source=${encodeURIComponent(source)}` : ''
    window.location.href = `/api/export?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}${srcParam}`
  }

  const handleExportPdf = async () => {
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageW = doc.internal.pageSize.getWidth()
    let y = 20

    doc.setFontSize(16)
    doc.setFont('helvetica', 'bold')
    doc.text('TramWatch — Noise Complaint Report', pageW / 2, y, { align: 'center' })
    y += 8

    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(100)
    doc.text(`Source: ${source || 'All sources'} · Period: ${from} to ${to}`, pageW / 2, y, { align: 'center' })
    y += 12

    if (stats) {
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(0)
      const statLabels = [
        `${stats.tram_passages} passages detected`,
        `${stats.outlier_passages} outliers (>${stats.outlier_threshold_db?.toFixed(1)} dB)`,
        `Typical: ${stats.median_passage_peak_db?.toFixed(1)} dB`,
        `Worst: ${stats.worst_peak_db?.toFixed(1)} dB`,
      ]
      statLabels.forEach((s, i) => {
        doc.text(s, 14 + i * (pageW - 28) / 4, y)
      })
      y += 12

      doc.setFontSize(10)
      doc.setFont('helvetica', 'italic')
      doc.setTextColor(60)
      const narrative = buildNarrative(stats, from, to, source)
      const lines = doc.splitTextToSize(narrative, pageW - 28)
      doc.text(lines, 14, y)
      y += lines.length * 5 + 8

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(0)
      doc.text('Time (Zurich)', 14, y)
      doc.text('Duration', 80, y)
      doc.text('Peak dB', 110, y)
      doc.text('vs typical', 140, y)
      doc.text('Outlier', 170, y)
      y += 5
      doc.setLineWidth(0.3)
      doc.line(14, y, pageW - 14, y)
      y += 3

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      for (const p of stats.passages) {
        if (y > 270) { doc.addPage(); y = 20 }
        if (p.is_outlier) doc.setTextColor(200, 80, 0)
        else doc.setTextColor(60)
        doc.text(formatZurichTime(p.start_ts, 'datetime'), 14, y)
        doc.text(`${p.duration_sec}s`, 80, y)
        doc.text(p.peak_db.toFixed(1), 110, y)
        const delta = p.peak_db - p.median_peak
        doc.text(`+${delta.toFixed(1)} dB`, 140, y)
        doc.text(p.is_outlier ? '! YES' : '-', 170, y)
        y += 5
      }
    }

    doc.save(`tramwatch-report-${source}-${from}-${to}.pdf`)
  }

  const chartData = useMemo(() => {
    const map = new Map<string, Record<string, number | string>>()
    for (const row of hourPoints) {
      const ts = String(row.bucket)
      if (!map.has(ts)) map.set(ts, { ts, label: formatZurichTime(ts, 'datetime') })
      map.get(ts)![row.source + '_leq']  = row.leq
      map.get(ts)![row.source + '_peak'] = row.l_peak
    }
    return Array.from(map.values()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  }, [hourPoints])

  const chartSources = useMemo(() =>
    Array.from(new Set(hourPoints.map(r => r.source))).sort()
  , [hourPoints])

  const tramBands = useMemo(() => {
    if (!stats?.passages.length) return []
    return stats.passages.map(p => ({
      x1: formatZurichTime(p.start_ts, 'datetime'),
      x2: formatZurichTime(p.end_ts,   'datetime'),
      isOutlier: p.is_outlier,
    }))
  }, [stats])

  const narrative = stats ? buildNarrative(stats, from, to, source) : null

  const chartStyle = {
    contentStyle: { backgroundColor: 'hsl(224 71% 7%)', border: '1px solid hsl(216 34% 17%)', borderRadius: '6px', fontSize: '12px' },
    axisProps: { tick: { fill: 'hsl(215 20% 55%)', fontSize: 11 }, tickLine: false as const, axisLine: false as const },
    grid: { strokeDasharray: '3 3', stroke: 'hsl(216 34% 17%)' },
  }

  return (
    <div className="p-4 space-y-4">

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-foreground">History</h1>
        <input type="date" value={from} max={to}
          onChange={e => setFrom(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" />
        <span className="text-muted-foreground text-sm">to</span>
        <input type="date" value={to} min={from} max={new Date().toISOString().substring(0, 10)}
          onChange={e => setTo(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground" />

        <select value={source} onChange={e => setSource(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground">
          <option value="">All sources</option>
          {sources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <Button size="sm" variant="outline" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>

        {source && (
          <Button size="sm" variant="outline"
            className="text-amber-400 border-amber-400/40 hover:bg-amber-400/10"
            onClick={handleRedetect} disabled={detectLoading}>
            <Zap className={`h-4 w-4 mr-1 ${detectLoading ? 'animate-pulse' : ''}`} />
            {detectLoading ? 'Detecting…' : 'Re-detect'}
          </Button>
        )}

        <Button size="sm" variant="outline" onClick={handleExportCsv}>
          <Download className="h-4 w-4 mr-1" /> Export CSV
        </Button>

        {source && stats && (
          <Button size="sm" variant="outline" onClick={handleExportPdf}>
            <FileText className="h-4 w-4 mr-1" /> PDF Report
          </Button>
        )}
      </div>

      {/* Re-detect result banner */}
      {detectResult && (
        <div className={`p-3 rounded-md text-sm flex items-center gap-2 ${
          detectResult.startsWith('Error') ? 'bg-destructive/20 text-destructive' : 'bg-amber-400/10 text-amber-400'}`}>
          <Zap className="h-4 w-4 flex-shrink-0" />
          {detectResult}
        </div>
      )}

      {error && <div className="p-3 rounded-md bg-destructive/20 text-destructive text-sm">{error}</div>}

      {/* Stat cards — single source only */}
      {source && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Tram passages</p>
              {loading ? <Skeleton className="h-8 w-16" /> : (
                <>
                  <p className="text-2xl font-bold text-amber-400">{stats?.tram_passages ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">{stats?.total_readings?.toLocaleString()} readings</p>
                </>
              )}
            </CardContent>
          </Card>
          <Card className={stats && stats.outlier_passages > 0 ? 'border-red-500/40' : ''}>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Outlier passages</p>
              {loading ? <Skeleton className="h-8 w-16" /> : (
                <>
                  <p className={`text-2xl font-bold ${stats && stats.outlier_passages > 0 ? 'text-red-400' : 'text-foreground'}`}>
                    {stats?.outlier_passages ?? '—'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {stats?.outlier_threshold_db != null ? `peak >${stats.outlier_threshold_db.toFixed(1)} dB (median+${OUTLIER_DELTA})` : 'of total'}
                  </p>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Typical passage</p>
              {loading ? <Skeleton className="h-8 w-16" /> : (
                <>
                  <p className="text-2xl font-bold text-blue-400">
                    {stats?.median_passage_peak_db != null ? `${stats.median_passage_peak_db.toFixed(1)} dB` : '—'}
                  </p>
                  <p className="text-xs text-muted-foreground">median peak</p>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Worst outlier</p>
              {loading ? <Skeleton className="h-8 w-16" /> : (
                <>
                  <p className="text-2xl font-bold text-red-400">
                    {stats?.worst_peak_db != null ? `${stats.worst_peak_db.toFixed(1)} dB` : '—'}
                  </p>
                  <p className="text-xs text-muted-foreground">peak recorded</p>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Hour chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Leq &amp; L_peak per hour
            {stats && <span className="ml-2 text-xs text-amber-400">{stats.tram_passages} passages · {stats.outlier_passages} outliers</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-64 w-full" /> : chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No data in this range.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid {...chartStyle.grid} />
                <XAxis dataKey="label" {...chartStyle.axisProps} interval="preserveStartEnd" />
                <YAxis domain={[20, 'auto']} allowDataOverflow={false}
                  tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
                <Tooltip contentStyle={chartStyle.contentStyle} formatter={(v: unknown) => [`${(v as number)?.toFixed(1)} dB(A)`]} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <ReferenceLine y={NOISE_LIMITS.day} stroke="#ef4444" strokeDasharray="6 3"
                  label={{ value: `Day ${NOISE_LIMITS.day}dB`, position: 'right', fill: '#ef4444', fontSize: 10 }} />
                <ReferenceLine y={NOISE_LIMITS.night} stroke="#f97316" strokeDasharray="6 3"
                  label={{ value: `Night ${NOISE_LIMITS.night}dB`, position: 'right', fill: '#f97316', fontSize: 10 }} />
                {tramBands.map((b, i) => (
                  <ReferenceArea key={i} x1={b.x1} x2={b.x2}
                    fill={b.isOutlier ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.10)'} strokeOpacity={0} />
                ))}
                {chartSources.flatMap((src, i) => {
                  const color = SOURCE_COLORS[i % SOURCE_COLORS.length]
                  return [
                    <Line key={src+'_leq'}  type="monotone" dataKey={src+'_leq'}  name={`${src} Leq`}
                      stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />,
                    <Line key={src+'_peak'} type="monotone" dataKey={src+'_peak'} name={`${src} L_peak`}
                      stroke={color} strokeWidth={1}   dot={false} isAnimationActive={false} connectNulls strokeDasharray="4 2" />,
                  ]
                })}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Passage table — single source only */}
      {source && stats && stats.passages.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Detected passages — sorted loudest first
              <span className="ml-2 text-xs text-red-400 inline-flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> {stats.outlier_passages} outlier(s) highlighted
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Time (Zurich)</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Duration</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Peak dB</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">vs typical</th>
                    <th className="text-right py-2 text-muted-foreground font-medium">Outlier</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.passages.map((p, i) => (
                    <tr key={i} className={`border-b border-border/50 ${p.is_outlier ? 'bg-red-500/5' : 'hover:bg-accent/30'}`}>
                      <td className="py-1.5 pr-4 text-xs font-mono text-muted-foreground">
                        {formatZurichTime(p.start_ts, 'datetime')}
                      </td>
                      <td className="py-1.5 pr-4 text-right font-mono text-xs">{p.duration_sec}s</td>
                      <td className={`py-1.5 pr-4 text-right font-mono text-xs font-medium ${p.is_outlier ? 'text-red-400' : 'text-amber-400'}`}>
                        {p.peak_db.toFixed(1)} dB
                      </td>
                      <td className="py-1.5 pr-4 text-right font-mono text-xs text-muted-foreground">
                        +{(p.peak_db - p.median_peak).toFixed(1)} dB
                      </td>
                      <td className="py-1.5 text-right text-xs">
                        {p.is_outlier ? <span className="text-red-400 font-medium">Yes</span> : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Narrative */}
      {source && stats && narrative && (
        <Card className="border-blue-500/20 bg-blue-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Auto-generated narrative — copy into email</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-foreground leading-relaxed italic">{narrative}</p>
          </CardContent>
        </Card>
      )}

    </div>
  )
}

function buildNarrative(stats: StatsResponse, from: string, to: string, source: string): string {
  if (stats.tram_passages === 0) {
    return `No tram passages were detected for source "${source}" between ${from} and ${to}. Consider running Re-detect to analyse the acoustic data.`
  }
  const parts: string[] = []
  parts.push(`Between ${from} and ${to}, ${stats.tram_passages} tram passage${stats.tram_passages !== 1 ? 's were' : ' was'} acoustically detected at the "${source}" measurement point.`)
  if (stats.median_passage_peak_db != null) {
    parts.push(`The typical passage peaked at ${stats.median_passage_peak_db.toFixed(1)} dB(A).`)
  }
  if (stats.outlier_passages > 0 && stats.outlier_threshold_db != null) {
    parts.push(`Of these, ${stats.outlier_passages} passage${stats.outlier_passages !== 1 ? 's were' : ' was'} particularly loud — peaking above ${stats.outlier_threshold_db.toFixed(1)} dB(A), more than ${OUTLIER_DELTA} dB above the typical event.`)
    if (stats.worst_peak_db != null) {
      parts.push(`The loudest outlier reached ${stats.worst_peak_db.toFixed(1)} dB(A).`)
    }
    parts.push(`These ${stats.outlier_passages} event${stats.outlier_passages !== 1 ? 's are' : ' is'} the focus of this report and may warrant investigation by the tram operator.`)
  } else {
    parts.push(`No passages were classified as outliers during this period.`)
  }
  return parts.join(' ')
}
