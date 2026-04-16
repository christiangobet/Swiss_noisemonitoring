'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
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
import { Button } from '@/components/ui/button'
import { Mic, MicOff } from 'lucide-react'
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

// ── Tram line colours ─────────────────────────────────────────────────────────
const LINE_COLORS: Record<string, string> = {
  '2':  '#f97316', '3':  '#ef4444', '4':  '#8b5cf6', '5':  '#06b6d4',
  '6':  '#22c55e', '7':  '#a855f7', '8':  '#3b82f6', '9':  '#eab308',
  '10': '#14b8a6', '11': '#ec4899', '12': '#84cc16', '13': '#f43f5e',
  '14': '#64748b', '15': '#d97706',
}
function lineColor(line: string) { return LINE_COLORS[line] ?? '#94a3b8' }
function withAlpha(hex: string, a: number) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

// ── Constants ─────────────────────────────────────────────────────────────────
const HISTORY_MS    = 3 * 60 * 1000  // 3 min history
const FUTURE_MS     = 2 * 60 * 1000  // 2 min future
const TRAM_PAD_MS   = 15 * 1000      // ±15 s tram band
const CHART_TICK_MS = 250            // chart update rate
const MIC_FLUSH_MS  = 2000           // DB flush interval
const DB_OFFSET     = 94             // dBFS → rough dBSPL

// Returns dB or null when audio context is suspended / signal is zero
function getRmsDb(analyser: AnalyserNode): number | null {
  const buf = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  const rms = Math.sqrt(sum / buf.length)
  if (rms < 1e-6) return null   // context suspended or no signal
  return 20 * Math.log10(rms) + DB_OFFSET
}

// ── Component ─────────────────────────────────────────────────────────────────
export function LiveChart() {
  const [dbPoints,  setDbPoints]  = useState<ChartPoint[]>([])
  const [micPoints, setMicPoints] = useState<ChartPoint[]>([])
  const [schedule,  setSchedule]  = useState<TramDep[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [micActive, setMicActive] = useState(false)
  const [micDb,     setMicDb]     = useState<number | null>(null)
  const [micError,  setMicError]  = useState<string | null>(null)

  const streamRef      = useRef<MediaStream | null>(null)
  const ctxRef         = useRef<AudioContext | null>(null)
  const analyserRef    = useRef<AnalyserNode | null>(null)
  const rafRef         = useRef<number>(0)
  const flushTimer     = useRef<ReturnType<typeof setInterval> | null>(null)
  const flushBuf       = useRef<Array<{ ts: string; db_raw: number }>>([])
  const lastTickMs     = useRef<number>(0)

  // Day/night ES II limit
  const limit = useMemo(() => {
    const h = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', hour: 'numeric', hour12: false })
        .format(new Date())
    )
    return (h < 6 || h >= 22) ? NOISE_LIMITS.night : NOISE_LIMITS.day
  }, [])

  // ── DB polling (exterior + stored interior) every 2 s ─────────────────────
  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch('/api/live')
      if (!res.ok) { setError('Failed to fetch live data'); return }
      const data: { exterior: Reading[]; interior: Reading[] } = await res.json()
      const cutoff = Date.now() - HISTORY_MS
      const extMap = new Map<string, number>()
      for (const r of data.exterior) if (r.db_cal !== null) extMap.set(r.ts, r.db_cal)
      const intMap = new Map<string, number>()
      for (const r of data.interior) if (r.db_cal !== null) intMap.set(r.ts, r.db_cal)
      const allTs = Array.from(new Set([
        ...Array.from(extMap.keys()),
        ...Array.from(intMap.keys()),
      ])).filter(ts => new Date(ts).getTime() >= cutoff).sort()
      setDbPoints(allTs.map(ts => ({
        tsMs: new Date(ts).getTime(),
        ext:  extMap.get(ts) ?? null,
        int:  intMap.get(ts) ?? null,
      })))
      setLoading(false)
      setError(null)
    } catch (err) { setError(String(err)) }
  }, [])

  const fetchSchedule = useCallback(async () => {
    try {
      const res = await fetch('/api/tram-schedule')
      if (res.ok) { const d = await res.json(); setSchedule(d.departures ?? []) }
    } catch { /* non-fatal */ }
  }, [])

  useEffect(() => {
    fetchLive()
    fetchSchedule()
    const t1 = setInterval(fetchLive,     2000)
    const t2 = setInterval(fetchSchedule, 30000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [fetchLive, fetchSchedule])

  // ── Browser mic ───────────────────────────────────────────────────────────
  const stopMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    if (flushTimer.current) clearInterval(flushTimer.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close().catch(() => {})
    streamRef.current = ctxRef.current = analyserRef.current = null
    flushBuf.current  = []
    lastTickMs.current = 0
    setMicActive(false)
    setMicDb(null)
    setMicPoints([])
  }, [])

  // Cleanup on unmount
  useEffect(() => stopMic, [stopMic])

  // Resume AudioContext when tab becomes visible again
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && ctxRef.current?.state === 'suspended') {
        ctxRef.current.resume().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const startMic = useCallback(async () => {
    setMicError(null)
    try {
      const savedId = localStorage.getItem('browserMicDeviceId')
      const stream  = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId:         savedId ? { ideal: savedId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
        },
      })
      streamRef.current = stream

      const ctx     = new AudioContext()
      const src     = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 4096
      src.connect(analyser)
      ctxRef.current      = ctx
      analyserRef.current = analyser

      // requestAnimationFrame loop — pauses automatically when tab is hidden,
      // no timer throttling, resumes cleanly when tab is visible again.
      const tick = () => {
        const actx = ctxRef.current
        const node = analyserRef.current
        if (!actx || !node) return

        // Keep context alive
        if (actx.state === 'suspended') actx.resume().catch(() => {})

        const db   = getRmsDb(node)
        const tsMs = Date.now()

        // Update live dB readout every frame
        setMicDb(db)

        // Update chart data at CHART_TICK_MS rate (avoid flooding React)
        if (tsMs - lastTickMs.current >= CHART_TICK_MS) {
          lastTickMs.current = tsMs
          if (db !== null) {
            setMicPoints(prev => {
              const cutoff = tsMs - HISTORY_MS
              return [...prev.filter(p => p.tsMs >= cutoff), { tsMs, ext: null, int: db }]
            })
            flushBuf.current.push({ ts: new Date(tsMs).toISOString(), db_raw: db })
          }
        }

        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      // Background DB flush
      flushTimer.current = setInterval(() => {
        const batch = flushBuf.current.splice(0, 30)
        if (!batch.length) return
        fetch('/api/browser-ingest', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ readings: batch }),
        }).catch(() => {})
      }, MIC_FLUSH_MS)

      setMicActive(true)
    } catch (e) {
      setMicError(e instanceof Error ? e.message : 'Microphone unavailable')
    }
  }, [])

  // ── Merge DB + live mic points ────────────────────────────────────────────
  const points = useMemo(() => {
    const map = new Map<number, ChartPoint>()
    for (const p of dbPoints) map.set(p.tsMs, { ...p })
    if (micActive) {
      for (const p of micPoints) {
        const ex = map.get(p.tsMs)
        map.set(p.tsMs, ex ? { ...ex, int: p.int } : p)
      }
    }
    return Array.from(map.values()).sort((a, b) => a.tsMs - b.tsMs)
  }, [dbPoints, micPoints, micActive])

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return <Skeleton className="w-full h-72" />
  if (error)   return (
    <div className="flex items-center justify-center h-72 text-muted-foreground text-sm">{error}</div>
  )

  const hasData    = points.length > 0
  const nowMs      = Date.now()
  const domainMin  = nowMs - HISTORY_MS
  const domainMax  = nowMs + FUTURE_MS

  const visibleTrams = schedule.filter(dep => {
    const ms = new Date(dep.expected).getTime()
    return ms + TRAM_PAD_MS >= domainMin && ms - TRAM_PAD_MS <= domainMax
  })

  const micDbColor = micDb === null ? '' : micDb >= 75 ? '#f87171' : micDb >= 60 ? '#fbbf24' : '#4ade80'

  return (
    <div className="w-full space-y-2">

      {/* Mic toggle row */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3 min-h-[2rem]">
          {micActive && (
            micDb !== null ? (
              <>
                <span className="font-mono text-2xl font-bold tabular-nums leading-none" style={{ color: micDbColor }}>
                  {micDb.toFixed(1)}
                </span>
                <span className="text-xs text-muted-foreground">dB(A)</span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground animate-pulse">Waiting for signal…</span>
            )
          )}
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <Button
            size="sm"
            variant={micActive ? 'destructive' : 'outline'}
            className="h-7 px-2 text-xs gap-1"
            onClick={micActive ? stopMic : startMic}
          >
            {micActive ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
            {micActive ? 'Stop mic' : 'Use mic'}
          </Button>
          {micError && <span className="text-xs text-destructive max-w-[200px] text-right">{micError}</span>}
        </div>
      </div>

      {/* Empty state */}
      {!hasData && !micActive && (
        <div className="flex flex-col items-center justify-center h-72 gap-2 text-muted-foreground text-sm">
          <span>No sensor data yet.</span>
          <span className="text-xs">
            Click <strong className="text-foreground">Use mic</strong> above to start monitoring from this device.
          </span>
        </div>
      )}

      {/* Chart — only render when there is something to show */}
      {(hasData || micActive) && (
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="4 4" stroke="hsl(216 34% 14%)" />

            <XAxis
              dataKey="tsMs"
              type="number"
              scale="time"
              domain={[domainMin, domainMax]}
              tickCount={6}
              tickFormatter={ms => formatZurichTime(new Date(ms).toISOString(), 'time')}
              tick={{ fill: 'hsl(215 20% 45%)', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              domain={[30, 95]}
              ticks={[30, 40, 50, 60, 70, 80, 90]}
              tick={{ fill: 'hsl(215 20% 45%)', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={28}
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

            {/* Tram departure bands */}
            {visibleTrams.map((dep, i) => {
              const ms    = new Date(dep.expected).getTime()
              const color = lineColor(dep.line)
              return (
                <ReferenceArea
                  key={`${dep.line}-${dep.expected}-${i}`}
                  x1={ms - TRAM_PAD_MS}
                  x2={ms + TRAM_PAD_MS}
                  fill={withAlpha(color, 0.13)}
                  stroke={withAlpha(color, 0.5)}
                  strokeWidth={1}
                  label={{
                    value: `${dep.line} ${dep.direction.split(' ')[0]}`,
                    position: 'insideTopLeft',
                    fill: color,
                    fontSize: 9,
                    fontWeight: 600,
                  }}
                />
              )
            })}

            {/* ES II noise limit */}
            <ReferenceLine
              y={limit}
              stroke="#ef4444"
              strokeDasharray="6 3"
              strokeWidth={1}
              label={{ value: `ES II ${limit} dB`, position: 'insideTopRight', fill: '#ef4444', fontSize: 10 }}
            />

            {/* Now marker */}
            <ReferenceLine
              x={nowMs}
              stroke="hsl(215 20% 40%)"
              strokeDasharray="3 3"
              strokeWidth={1}
            />

            <Line
              type="linear"
              dataKey="ext"
              name="ext"
              stroke="#F59E0B"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              type="linear"
              dataKey="int"
              name="int"
              stroke="#60A5FA"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-px bg-amber-400" /> Exterior
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-px bg-blue-400" />
          Interior{micActive ? ' (mic)' : ''}
        </span>
        {Array.from(new Set(schedule.map(d => d.line))).map(line => (
          <span key={line} className="flex items-center gap-1">
            <span className="inline-block w-2.5 h-3 rounded-sm" style={{ backgroundColor: withAlpha(lineColor(line), 0.6) }} />
            Line {line}
          </span>
        ))}
      </div>
    </div>
  )
}
