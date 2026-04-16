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
const HISTORY_MS     = 3 * 60 * 1000   // 3 min history
const FUTURE_MS      = 2 * 60 * 1000   // 2 min future
const TRAM_PAD_MS    = 15 * 1000       // ±15 s tram band
const MIC_SAMPLE_MS  = 250             // browser mic sample interval
const MIC_FLUSH_MS   = 2000            // flush to DB every 2 s
const DB_OFFSET      = 94              // dBFS → rough dBSPL (calibration corrects)

// ── Browser mic helpers ───────────────────────────────────────────────────────
function getRmsDb(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return 20 * Math.log10(Math.max(Math.sqrt(sum / buf.length), 1e-10)) + DB_OFFSET
}

// ── Component ─────────────────────────────────────────────────────────────────
export function LiveChart() {
  // DB-sourced points (exterior + stored interior)
  const [dbPoints,  setDbPoints]  = useState<ChartPoint[]>([])
  // Browser mic points (interior only, real-time, no DB lag)
  const [micPoints, setMicPoints] = useState<ChartPoint[]>([])
  const [schedule,  setSchedule]  = useState<TramDep[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  // Browser mic state
  const [micActive,  setMicActive]  = useState(false)
  const [micDb,      setMicDb]      = useState<number | null>(null)
  const [micError,   setMicError]   = useState<string | null>(null)

  const streamRef   = useRef<MediaStream | null>(null)
  const ctxRef      = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const flushBuf    = useRef<Array<{ ts: string; db_raw: number }>>([])
  const sampleTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const flushTimer  = useRef<ReturnType<typeof setInterval> | null>(null)

  // Day/night ES II limit (computed once per render)
  const limit = useMemo(() => {
    const h = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', hour: 'numeric', hour12: false })
        .format(new Date())
    )
    return (h < 6 || h >= 22) ? NOISE_LIMITS.night : NOISE_LIMITS.day
  }, [])

  // ── Fetch DB readings every 2 s ───────────────────────────────────────────
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
    } catch (err) {
      setError(String(err))
    }
  }, [])

  // ── Fetch tram schedule every 30 s ────────────────────────────────────────
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
    const t1 = setInterval(fetchLive,     2000)
    const t2 = setInterval(fetchSchedule, 30000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [fetchLive, fetchSchedule])

  // Cleanup mic on unmount
  useEffect(() => () => stopMic(), [])

  // ── Browser mic controls ──────────────────────────────────────────────────
  const stopMic = () => {
    if (sampleTimer.current) clearInterval(sampleTimer.current)
    if (flushTimer.current)  clearInterval(flushTimer.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close().catch(() => {})
    streamRef.current = ctxRef.current = analyserRef.current = null
    flushBuf.current  = []
    setMicActive(false)
    setMicDb(null)
    setMicPoints([])
  }

  const startMic = async () => {
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

      const ctx = new AudioContext()
      ctxRef.current = ctx
      const src  = ctx.createMediaStreamSource(stream)
      const node = ctx.createAnalyser()
      node.fftSize = 4096
      src.connect(node)
      analyserRef.current = node

      // Sample: update chart in real-time
      sampleTimer.current = setInterval(() => {
        if (!analyserRef.current) return
        const db    = getRmsDb(analyserRef.current)
        const tsMs  = Date.now()
        const valid = Math.max(0, db)
        setMicDb(db)
        setMicPoints(prev => {
          const cutoff = tsMs - HISTORY_MS
          return [...prev.filter(p => p.tsMs >= cutoff), { tsMs, ext: null, int: valid }]
        })
        flushBuf.current.push({ ts: new Date(tsMs).toISOString(), db_raw: valid })
      }, MIC_SAMPLE_MS)

      // Flush: persist to DB in background
      flushTimer.current = setInterval(async () => {
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
  }

  // ── Merge DB + mic points ─────────────────────────────────────────────────
  const points = useMemo(() => {
    const map = new Map<number, ChartPoint>()
    for (const p of dbPoints) map.set(p.tsMs, { ...p })
    // Mic is interior only; when mic is active, override int from DB
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

  const hasData = points.length > 0 || micPoints.length > 0

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

      {/* Mic toggle + live readout */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          {micActive && micDb !== null && (
            <>
              <span className="font-mono text-2xl font-bold tabular-nums" style={{ color: micDbColor }}>
                {micDb.toFixed(1)}
              </span>
              <span className="text-xs text-muted-foreground">dB(A) interior</span>
            </>
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
          {micError && <span className="text-xs text-destructive">{micError}</span>}
        </div>
      </div>

      {/* Empty state */}
      {!hasData && !micActive && (
        <div className="flex flex-col items-center justify-center h-72 gap-2 text-muted-foreground text-sm">
          <span>No sensor data yet.</span>
          <span className="text-xs">Click <strong className="text-foreground">Use mic</strong> above to start monitoring from this device.</span>
        </div>
      )}

      {/* Chart */}
      {(hasData || micActive) && <ResponsiveContainer width="100%" height={340}>
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

          {/* Tram bands */}
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

          {/* ES II limit */}
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

          {/* Exterior — amber, sharp ECG line */}
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

          {/* Interior — blue */}
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
      </ResponsiveContainer>}

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
