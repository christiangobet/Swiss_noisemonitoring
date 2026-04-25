'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  BarChart,
  Bar,
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
import { NOISE_LIMITS } from '@/lib/utils'
import { Download } from 'lucide-react'

type Period = 'week' | 'month'

interface StatsData {
  period_hours: number
  day_leq_ext: number | null
  night_leq_ext: number | null
  day_leq_int: number | null
  night_leq_int: number | null
  attenuation_mean_db: number | null
  tram_delta_db: number | null
  exceedance_minutes_day: number
  exceedance_minutes_night: number
  tram_events_count: number
  by_line: Array<{
    line: string
    headsign: string
    count: number
    mean_db_ext: number | null
  }>
  by_hour: Array<{ hour: number; leq_ext: number | null; leq_int: number | null }>
}

function MetricRow({ label, value, limit, unit = 'dB(A)' }: { label: string; value: number | null; limit?: number; unit?: string }) {
  const over = limit != null && value != null && value > limit
  return (
    <div className="flex justify-between items-center py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`font-db text-sm font-semibold ${over ? 'text-red-400' : 'text-foreground'}`}>
        {value != null ? `${value.toFixed(1)} ${unit}` : '—'}
        {over && limit != null && value != null && (
          <span className="text-xs text-red-400 ml-1">(+{(value - limit).toFixed(1)})</span>
        )}
      </span>
    </div>
  )
}

export default function ReportsPage() {
  const [period, setPeriod] = useState<Period>('week')
  const [stats, setStats] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  const hours = period === 'week' ? 168 : 720

  const fetchStats = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/stats?hours=${hours}`)
      if (res.ok) setStats(await res.json())
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [hours])

  useEffect(() => { fetchStats() }, [fetchStats])

  const exportPdf = async () => {
    if (!stats) return
    setExporting(true)
    try {
      const { jsPDF } = await import('jspdf')
      const { default: autoTable } = await import('jspdf-autotable')

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const periodLabel = period === 'week' ? 'Weekly' : 'Monthly'
      const title = `TramWatch — ${periodLabel} Noise Report`
      const subtitle = `Römerhofplatz, Zürich · Swiss LSV ES II Residential Zone`
      const generated = `Generated: ${new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })}`

      // Header
      doc.setFillColor(15, 23, 42) // dark blue
      doc.rect(0, 0, 210, 30, 'F')
      doc.setTextColor(245, 158, 11) // amber
      doc.setFontSize(16)
      doc.setFont('courier', 'bold')
      doc.text(title, 14, 13)
      doc.setTextColor(148, 163, 184)
      doc.setFontSize(9)
      doc.setFont('courier', 'normal')
      doc.text(subtitle, 14, 20)
      doc.text(generated, 14, 26)

      doc.setTextColor(30, 41, 59)

      // Summary section
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(15, 23, 42)
      doc.text('Noise Levels vs ES II Limits', 14, 42)

      autoTable(doc, {
        startY: 46,
        head: [['Metric', 'Value', 'ES II Limit', 'Status']],
        body: [
          ['Day Leq Exterior', stats.day_leq_ext != null ? `${stats.day_leq_ext.toFixed(1)} dB(A)` : '—', `${NOISE_LIMITS.day} dB(A)`, stats.day_leq_ext != null && stats.day_leq_ext > NOISE_LIMITS.day ? '⚠ OVER' : '✓ OK'],
          ['Night Leq Exterior', stats.night_leq_ext != null ? `${stats.night_leq_ext.toFixed(1)} dB(A)` : '—', `${NOISE_LIMITS.night} dB(A)`, stats.night_leq_ext != null && stats.night_leq_ext > NOISE_LIMITS.night ? '⚠ OVER' : '✓ OK'],
          ['Day Leq Interior', stats.day_leq_int != null ? `${stats.day_leq_int.toFixed(1)} dB(A)` : '—', '—', '—'],
          ['Night Leq Interior', stats.night_leq_int != null ? `${stats.night_leq_int.toFixed(1)} dB(A)` : '—', '—', '—'],
          ['Mean Attenuation', stats.attenuation_mean_db != null ? `${stats.attenuation_mean_db.toFixed(1)} dB` : '—', '—', '—'],
        ],
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [15, 23, 42], textColor: [245, 158, 11] },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 3: { fontStyle: 'bold' } },
      })

      const y1 = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8

      // Exceedance section
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.text('Exceedances', 14, y1)

      autoTable(doc, {
        startY: y1 + 4,
        head: [['Period', 'Minutes Over Limit', 'Hours Over Limit']],
        body: [
          ['Day (06:00–22:00)', String(stats.exceedance_minutes_day), (stats.exceedance_minutes_day / 60).toFixed(1)],
          ['Night (22:00–06:00)', String(stats.exceedance_minutes_night), (stats.exceedance_minutes_night / 60).toFixed(1)],
        ],
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [15, 23, 42], textColor: [245, 158, 11] },
      })

      const y2 = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8

      // Tram section
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.text('Tram Contribution', 14, y2)

      const tramRows = stats.by_line.map(l => [
        `Line ${l.line}`, l.headsign ?? '—',
        String(l.count),
        l.mean_db_ext != null ? `${l.mean_db_ext.toFixed(1)} dB(A)` : '—',
      ])

      autoTable(doc, {
        startY: y2 + 4,
        head: [['Line', 'Direction', 'Events', 'Mean dB(A)']],
        body: tramRows.length > 0 ? tramRows : [['—', '—', '0', '—']],
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [15, 23, 42], textColor: [245, 158, 11] },
      })

      // Footer
      const pageHeight = doc.internal.pageSize.height
      doc.setFontSize(8)
      doc.setTextColor(148, 163, 184)
      doc.text(
        'TramWatch — Residential Noise Monitoring — Data under Swiss LSV (Lärmschutz-Verordnung)',
        14,
        pageHeight - 8
      )

      const filename = `tramwatch-${period}-${new Date().toISOString().substring(0, 10)}.pdf`
      doc.save(filename)
    } catch (err) {
      console.error('PDF export error:', err)
    } finally {
      setExporting(false)
    }
  }

  const hourlyData = (stats?.by_hour ?? []).map(h => ({
    hour: `${String(h.hour).padStart(2, '0')}:00`,
    ext: h.leq_ext,
    int: h.leq_int,
  }))

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-foreground">Reports</h1>
        <div className="flex rounded-md border border-input overflow-hidden">
          {(['week', 'month'] as Period[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-sm transition-colors ${
                period === p ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
              }`}
            >
              {p === 'week' ? 'Last 7 days' : 'Last 30 days'}
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={exportPdf} disabled={!stats || exporting}>
          <Download className="h-4 w-4 mr-2" />
          {exporting ? 'Exporting…' : 'Export PDF'}
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Noise Levels vs ES II
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-32 w-full" /> : (
              <>
                <MetricRow label="Day Leq Exterior" value={stats?.day_leq_ext ?? null} limit={NOISE_LIMITS.day} />
                <MetricRow label="Night Leq Exterior" value={stats?.night_leq_ext ?? null} limit={NOISE_LIMITS.night} />
                <MetricRow label="Day Leq Interior" value={stats?.day_leq_int ?? null} />
                <MetricRow label="Night Leq Interior" value={stats?.night_leq_int ?? null} />
                <MetricRow label="Mean Attenuation" value={stats?.attenuation_mean_db ?? null} unit="dB" />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Exceedances &amp; Tram
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-32 w-full" /> : (
              <>
                <MetricRow label="Day exceedance (min)" value={stats?.exceedance_minutes_day ?? null} unit="min" />
                <MetricRow label="Night exceedance (min)" value={stats?.exceedance_minutes_night ?? null} unit="min" />
                <MetricRow label="Tram events" value={stats?.tram_events_count ?? null} unit="" />
                <MetricRow label="Tram delta vs background" value={stats?.tram_delta_db ?? null} unit="dB" />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Hourly chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Hourly Average dB(A) — Last {period === 'week' ? '7' : '30'} days
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-64 w-full" /> : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={hourlyData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(216 34% 17%)" />
                <XAxis dataKey="hour" tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis domain={[30, 80]} tick={{ fill: 'hsl(215 20% 55%)', fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'hsl(224 71% 7%)', border: '1px solid hsl(216 34% 17%)', borderRadius: '6px', fontSize: '12px' }}
                  formatter={(v: number) => [`${v?.toFixed(1)} dB(A)`]}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <ReferenceLine y={NOISE_LIMITS.day} stroke="#ef4444" strokeDasharray="6 3" label={{ value: `${NOISE_LIMITS.day} day`, position: 'right', fill: '#ef4444', fontSize: 9 }} />
                <ReferenceLine y={NOISE_LIMITS.night} stroke="#f97316" strokeDasharray="6 3" label={{ value: `${NOISE_LIMITS.night} night`, position: 'right', fill: '#f97316', fontSize: 9 }} />
                <Bar dataKey="ext" name="Exterior" fill="#F59E0B" opacity={0.8} radius={[2, 2, 0, 0]} />
                <Bar dataKey="int" name="Interior" fill="#60A5FA" opacity={0.8} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* By tram line */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            By Tram Line
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-24 w-full" /> : (
            stats?.by_line && stats.by_line.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Line</th>
                      <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Direction</th>
                      <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Events</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">Mean Ext dB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.by_line.map((l, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-2 pr-4 font-semibold text-amber-400">Line {l.line}</td>
                        <td className="py-2 pr-4 text-foreground">{l.headsign ?? '—'}</td>
                        <td className="py-2 pr-4 text-right font-db">{l.count}</td>
                        <td className="py-2 text-right font-db">{l.mean_db_ext?.toFixed(1) ?? '—'} dB</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No tram event data in this period.</p>
            )
          )}
        </CardContent>
      </Card>
    </div>
  )
}
