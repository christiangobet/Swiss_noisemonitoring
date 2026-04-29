'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import CorrelationChart, {
  type HourPoint,
  type TramEvent,
  type TramLineOffset,
} from '@/components/analysis/correlation-chart'
import TramOffsetPanel from '@/components/analysis/tram-offset-panel'

const PRESETS = [
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d',  hours: 168 },
  { label: '30d', hours: 720 },
  { label: '3mo', hours: 2160 },
]

function toDateStr(d: Date) {
  return d.toISOString().substring(0, 10)
}

export default function AnalysisPage() {
  const now     = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000)

  const [from, setFrom]                 = useState(toDateStr(weekAgo))
  const [to, setTo]                     = useState(toDateStr(now))
  const [activePreset, setActivePreset] = useState<string | null>('7d')
  const [hourPoints, setHourPoints]     = useState<HourPoint[]>([])
  const [tramEvents, setTramEvents]     = useState<TramEvent[]>([])
  const [offsets, setOffsets]           = useState<TramLineOffset[]>([])
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)

  function applyPreset(p: typeof PRESETS[number]) {
    const toDate   = new Date()
    const fromDate = new Date(toDate.getTime() - p.hours * 3600 * 1000)
    setFrom(toDateStr(fromDate))
    setTo(toDateStr(toDate))
    setActivePreset(p.label)
  }

  const rangeHours = Math.round(
    (new Date(to + 'T23:59:59').getTime() - new Date(from + 'T00:00:00').getTime()) / 3_600_000
  )
  const showTramMarkers = rangeHours <= 48

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fromIso = new Date(from + 'T00:00:00').toISOString()
      const toIso   = new Date(to   + 'T23:59:59').toISOString()

      const histRes = await fetch(
        `/api/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&resolution=hour`
      )
      if (!histRes.ok) throw new Error('Failed to load noise data')
      const histData = await histRes.json()
      setHourPoints(histData.points ?? [])

      if (showTramMarkers) {
        const tramRes = await fetch(
          `/api/analysis/tram-events?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
        )
        if (!tramRes.ok) throw new Error('Failed to load tram events')
        const tramData = await tramRes.json()
        setTramEvents(tramData.events ?? [])
      } else {
        setTramEvents([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [from, to, showTramMarkers])

  useEffect(() => { fetchData() }, [fetchData])

  const sourceNames = Array.from(new Set(hourPoints.map(p => p.source))).sort()
  const knownLines  = Array.from(
    new Map(
      tramEvents
        .filter(e => e.line && e.direction)
        .map(e => [`${e.line}|${e.direction}`, { line: e.line, direction: e.direction }])
    ).values()
  ).sort((a, b) => a.line.localeCompare(b.line) || a.direction.localeCompare(b.direction))

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold">Analysis</h1>

      {/* Time range selector */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex flex-col sm:flex-row flex-wrap gap-3 items-start sm:items-center">
            <div className="flex gap-1 flex-wrap">
              {PRESETS.map(p => (
                <Button
                  key={p.label}
                  size="sm"
                  variant={activePreset === p.label ? 'default' : 'outline'}
                  onClick={() => applyPreset(p)}
                  className="h-7 px-3 text-xs"
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <span className="text-muted-foreground">From</span>
              <input
                type="date"
                value={from}
                onChange={e => { setFrom(e.target.value); setActivePreset(null) }}
                className="bg-muted border border-border rounded px-2 py-1 text-sm text-foreground"
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="date"
                value={to}
                onChange={e => { setTo(e.target.value); setActivePreset(null) }}
                className="bg-muted border border-border rounded px-2 py-1 text-sm text-foreground"
              />
              <Button
                size="sm"
                onClick={fetchData}
                disabled={loading}
                className="h-7 px-3 text-xs"
              >
                {loading ? 'Loading…' : 'Load'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Chart */}
      <Card>
        <CardContent className="pt-4">
          {error && <p className="text-sm text-destructive mb-4">{error}</p>}
          {loading ? (
            <Skeleton className="h-[380px] w-full" />
          ) : hourPoints.length === 0 ? (
            <div className="h-[380px] flex items-center justify-center text-muted-foreground text-sm">
              No noise data for this range.
            </div>
          ) : (
            <CorrelationChart
              hourPoints={hourPoints}
              tramEvents={tramEvents}
              offsets={offsets}
              activeSourceNames={sourceNames}
              showTramMarkers={showTramMarkers}
            />
          )}
          {!showTramMarkers && !loading && hourPoints.length > 0 && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              Tram markers shown for ranges ≤ 48 h. Select 24h or 48h to see individual passages.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Tram offset panel — only when markers are active */}
      {showTramMarkers && (
        <TramOffsetPanel
          knownLines={knownLines}
          onOffsetsChange={setOffsets}
        />
      )}
    </div>
  )
}
