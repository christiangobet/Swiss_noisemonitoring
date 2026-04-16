'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatZurichTime } from '@/lib/utils'
import { Activity } from 'lucide-react'

interface PassageSummary {
  tram_line:     string
  tram_dir:      string
  passage_count: number
  max_db:        number
  avg_peak_db:   number
  avg_mean_db:   number
  avg_duration_s: number
  last_detected: string
}

const LINE_COLORS: Record<string, string> = {
  '2':  '#f97316', '3':  '#ef4444', '4':  '#8b5cf6', '5':  '#06b6d4',
  '6':  '#22c55e', '7':  '#a855f7', '8':  '#3b82f6', '9':  '#eab308',
  '10': '#14b8a6', '11': '#ec4899', '12': '#84cc16', '13': '#f43f5e',
  '14': '#64748b', '15': '#d97706',
}
function lineColor(l: string) { return LINE_COLORS[l] ?? '#94a3b8' }

function dbBar(db: number, max = 90) {
  const pct = Math.max(0, Math.min(100, ((db - 30) / (max - 30)) * 100))
  const col  = db >= 75 ? '#f87171' : db >= 65 ? '#fbbf24' : '#4ade80'
  return { pct, col }
}

export function TramStats() {
  const [summary, setSummary] = useState<PassageSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [lastRun, setLastRun] = useState<Date | null>(null)

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/events/summary')
      if (res.ok) {
        const data = await res.json()
        setSummary(data.summary ?? [])
      }
    } catch { /* non-fatal */ } finally {
      setLoading(false)
    }
  }, [])

  const runDetection = useCallback(async () => {
    setDetecting(true)
    try {
      await fetch('/api/events/detect', { method: 'POST' })
      await fetchSummary()
      setLastRun(new Date())
    } catch { /* non-fatal */ } finally {
      setDetecting(false)
    }
  }, [fetchSummary])

  useEffect(() => {
    fetchSummary()
    // Auto-run detection every 5 min to keep stats fresh
    runDetection()
    const t = setInterval(runDetection, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [fetchSummary, runDetection])

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Tram Noise Impact
            </CardTitle>
            <CardDescription className="mt-0.5">
              Peak exterior dB per line &amp; direction — learned from recorded passages
              {lastRun && (
                <span className="ml-2 opacity-60">
                  · updated {formatZurichTime(lastRun.toISOString(), 'time')}
                </span>
              )}
            </CardDescription>
          </div>
          <button
            onClick={runDetection}
            disabled={detecting}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 shrink-0 mt-0.5"
            title="Re-run detection now"
          >
            {detecting ? 'Detecting…' : 'Refresh'}
          </button>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : summary.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No passages detected yet. The system needs exterior sensor data with tram flags.<br />
            <span className="text-xs opacity-70">Runs automatically every 5 minutes once readings are being ingested.</span>
          </p>
        ) : (
          <div className="space-y-3">
            {summary.map(row => {
              const color       = lineColor(row.tram_line)
              const { pct, col } = dbBar(row.max_db)
              const shortDir    = row.tram_dir.split(',')[0].trim()

              return (
                <div key={`${row.tram_line}-${row.tram_dir}`} className="space-y-1">
                  {/* Header row */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-flex items-center justify-center w-6 h-5 rounded text-[10px] font-black shrink-0"
                        style={{ backgroundColor: color + '30', color }}
                      >
                        {row.tram_line}
                      </span>
                      <span className="text-sm text-foreground truncate">{shortDir}</span>
                      <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                        {row.passage_count}×
                      </Badge>
                    </div>
                    <div className="flex items-baseline gap-2 shrink-0 ml-2">
                      <span className="font-mono text-sm font-bold" style={{ color: col }}>
                        {row.max_db.toFixed(1)}
                      </span>
                      <span className="text-xs text-muted-foreground">dB max</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        ({row.avg_peak_db.toFixed(1)} avg)
                      </span>
                    </div>
                  </div>

                  {/* dB bar */}
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${pct}%`, backgroundColor: col }}
                    />
                  </div>

                  {/* Detail row */}
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground pl-8">
                    <span>avg {row.avg_duration_s}s duration</span>
                    <span>last {formatZurichTime(row.last_detected, 'time')}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
