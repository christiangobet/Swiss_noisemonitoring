'use client'

import { useEffect, useState, useCallback, useRef, useMemo, useTransition } from 'react'
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
import { Mic, MicOff, Tag } from 'lucide-react'
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

interface ManualTag {
  tagMs:   number   // when user pressed T — visual anchor
  startMs: number   // detected passage start (auto-expanded)
  endMs:   number   // detected passage end (auto-expanded)
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
const TRAM_PAD_MS   = 20 * 1000      // ±20 s tram band
const CHART_TICK_MS   = 250    // display refresh — smooth ECG
const STORAGE_TICK_MS = 1000   // one sample/s written to DB (10× fewer writes)
const MIC_FLUSH_MS    = 10000  // flush to DB every 10 s (10 readings/batch)
const DB_OFFSET       = 94     // dBFS → rough dBSPL

// ── Frequency analysis ────────────────────────────────────────────────────────
// 8 octave bands. Groups follow acoustic research on tram noise:
//   low     → broadband mechanical base (not very discriminative on its own)
//   rolling → impact/rolling noise 500–1 kHz
//   squeal  → squeal / tonal peaks 1–5 kHz  ← most discriminative
//   flange  → flanging / broadband >5 kHz

type BandGroup = 'low' | 'rolling' | 'squeal' | 'flange'

const BANDS: Array<{ label: string; fMin: number; fMax: number; group: BandGroup }> = [
  { label: '63',  fMin:   45, fMax:   90, group: 'low'     },
  { label: '125', fMin:   90, fMax:  180, group: 'low'     },
  { label: '250', fMin:  180, fMax:  355, group: 'low'     },
  { label: '500', fMin:  355, fMax:  710, group: 'rolling' },
  { label: '1k',  fMin:  710, fMax: 1400, group: 'rolling' },
  { label: '2k',  fMin: 1400, fMax: 2800, group: 'squeal'  },
  { label: '4k',  fMin: 2800, fMax: 5600, group: 'squeal'  },
  { label: '8k',  fMin: 5600, fMax: 11200, group: 'flange' },
]

const GROUP_COLOR: Record<BandGroup, string> = {
  low:     '#64748b',  // slate  — not used in score
  rolling: '#f97316',  // orange — rolling/impact
  squeal:  '#eab308',  // yellow — squeal, most discriminative
  flange:  '#ef4444',  // red    — flanging / broadband HF
}

// Baseline window: 60 s × 4 frames/s = 240 frames (20th-percentile → ambient floor)
const BASELINE_FRAMES = 240

function computeBands(freqData: Float32Array<ArrayBuffer>, sampleRate: number): number[] {
  const binHz = sampleRate / (freqData.length * 2)
  return BANDS.map(({ fMin, fMax }) => {
    const lo = Math.max(0, Math.floor(fMin / binHz))
    const hi = Math.min(freqData.length - 1, Math.ceil(fMax / binHz))
    let power = 0; let n = 0
    for (let i = lo; i <= hi; i++) { power += Math.pow(10, freqData[i] / 10); n++ }
    return n > 0 ? 10 * Math.log10(power / n) : -120
  })
}

interface TramScore { score: number; rolling: number; squeal: number; flange: number }

// Relative detection: compare band power against the rolling ambient baseline.
// Each sub-score measures how much that mechanism is elevated above ambient.
// Ratio 1.5× ≈ +2 dB → 0 %; ratio 10× ≈ +10 dB → 100 %.
// Combined score weights squeal highest (most discriminative).
function computeTramScore(bands: number[], baseline: number[]): TramScore {
  if (baseline.length < BANDS.length) return { score: 0, rolling: 0, squeal: 0, flange: 0 }

  const elevation = (idxs: number[]) => {
    const cur = idxs.reduce((s, i) => s + Math.pow(10, bands[i]    / 10), 0)
    const bas = idxs.reduce((s, i) => s + Math.pow(10, baseline[i] / 10), 0)
    const ratio = cur / (bas + 1e-10)
    return Math.round(Math.min(100, Math.max(0, (ratio - 1.5) / 8.5 * 100)))
  }

  const rolling = elevation([3, 4])   // 500 Hz – 1 kHz  impact / rolling
  const squeal  = elevation([5, 6])   // 1–5 kHz          squeal (most discriminative)
  const flange  = elevation([7])      // >5 kHz            flanging / broadband HF

  // Weighted sum; all three must contribute to avoid single-band false positives
  const score = Math.round(0.40 * squeal + 0.35 * rolling + 0.25 * flange)
  return { score, rolling, squeal, flange }
}

/**
 * Given a set of recent dB readings and a user-tag timestamp, walk backwards
 * and forwards to find where the elevated noise actually starts and ends.
 * Uses the 15th-percentile of readings in the search window as the baseline;
 * anything ≥ baseline + THRESHOLD_DB counts as "passage noise".
 */
const PASSAGE_THRESHOLD_DB = 3.5   // dB above ambient to count as passage
const PASSAGE_LOOK_MS      = 90_000 // look up to ±90 s from the tag

function detectPassageBounds(
  points: ChartPoint[],
  tagMs: number
): { startMs: number; endMs: number } {
  const window = points
    .filter(p => p.int !== null &&
      p.tsMs >= tagMs - PASSAGE_LOOK_MS &&
      p.tsMs <= tagMs + PASSAGE_LOOK_MS)
    .sort((a, b) => a.tsMs - b.tsMs)

  if (window.length < 4) return { startMs: tagMs - 5000, endMs: tagMs + 5000 }

  // Baseline: 15th percentile across the search window
  const sorted   = window.map(p => p.int as number).sort((a, b) => a - b)
  const baseline = sorted[Math.floor(sorted.length * 0.15)]
  const threshold = baseline + PASSAGE_THRESHOLD_DB

  // Index of point closest to tag time
  let nearestIdx = 0
  let nearestDist = Infinity
  for (let i = 0; i < window.length; i++) {
    const d = Math.abs(window[i].tsMs - tagMs)
    if (d < nearestDist) { nearestDist = d; nearestIdx = i }
  }

  // Walk backwards to find where level drops below threshold
  let startIdx = nearestIdx
  for (let i = nearestIdx; i >= 0; i--) {
    if ((window[i].int as number) < threshold) break
    startIdx = i
  }

  // Walk forwards to find where level drops below threshold
  let endIdx = nearestIdx
  for (let i = nearestIdx; i < window.length; i++) {
    if ((window[i].int as number) < threshold) break
    endIdx = i
  }

  // Ensure a minimum ±5 s span so the tag is always visible on the chart
  return {
    startMs: Math.min(window[startIdx].tsMs, tagMs - 5000),
    endMs:   Math.max(window[endIdx].tsMs,   tagMs + 5000),
  }
}

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
  const [micActive,    setMicActive]    = useState(false)
  const [micDb,        setMicDb]        = useState<number | null>(null)
  const [micError,     setMicError]     = useState<string | null>(null)
  const [micSaveError, setMicSaveError] = useState<string | null>(null)
  const [bands,      setBands]     = useState<number[]>([])
  const [tramScore,  setTramScore] = useState<TramScore>({ score: 0, rolling: 0, squeal: 0, flange: 0 })
  const [manualTags, setManualTags] = useState<ManualTag[]>([])
  const [tagFlash,   setTagFlash]   = useState(false)
  const [, startTransition] = useTransition()

  const streamRef      = useRef<MediaStream | null>(null)
  const ctxRef         = useRef<AudioContext | null>(null)
  const analyserRef    = useRef<AnalyserNode | null>(null)
  const freqBufRef     = useRef<Float32Array<ArrayBuffer> | null>(null)
  const rafRef         = useRef<number>(0)
  const flushTimer     = useRef<ReturnType<typeof setInterval> | null>(null)
  const flushBuf       = useRef<Array<{ ts: string; db_raw: number; tram_flag?: boolean }>>([])
  const lastTickMs     = useRef<number>(0)   // display throttle
  const lastStoreMs    = useRef<number>(0)   // storage throttle (1/s)
  const currentDbRef   = useRef<number | null>(null)
  const micPointsRef   = useRef<ChartPoint[]>([])
  const bandHistoryRef = useRef<number[][]>([])       // rolling band history for ambient baseline

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

  // Keep ref in sync so tagTram can read it without a stale closure
  useEffect(() => { micPointsRef.current = micPoints }, [micPoints])

  // ── Manual tram tag ───────────────────────────────────────────────────────
  const tagTram = useCallback(() => {
    const tagMs = Date.now()
    // Detect actual passage bounds by walking the noise envelope around the tag
    const { startMs, endMs } = detectPassageBounds(micPointsRef.current, tagMs)

    setManualTags(prev => [
      ...prev.filter(t => t.tagMs >= tagMs - HISTORY_MS),
      { tagMs, startMs, endMs },
    ])
    setTagFlash(true)
    setTimeout(() => setTagFlash(false), 1500)

    // Flush every reading within the detected passage window as tram_flag=true
    const passagePoints = micPointsRef.current.filter(
      p => p.int !== null && p.tsMs >= startMs && p.tsMs <= endMs
    )
    for (const p of passagePoints) {
      flushBuf.current.push({
        ts:        new Date(p.tsMs).toISOString(),
        db_raw:    p.int as number,
        tram_flag: true,
      })
    }
    // Always include the exact tag moment in case passagePoints was empty
    const db = currentDbRef.current
    if (db !== null && !passagePoints.some(p => Math.abs(p.tsMs - tagMs) < 500)) {
      flushBuf.current.push({ ts: new Date(tagMs).toISOString(), db_raw: db, tram_flag: true })
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return
      const tag = e.target as HTMLElement
      if (tag.tagName === 'INPUT' || tag.tagName === 'TEXTAREA') return
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); startTransition(tagTram) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tagTram, startTransition])

  // ── Browser mic ───────────────────────────────────────────────────────────
  const stopMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    if (flushTimer.current) clearInterval(flushTimer.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close().catch(() => {})
    streamRef.current = ctxRef.current = analyserRef.current = freqBufRef.current = null
    currentDbRef.current = null
    // Drain any remaining unflushed readings before clearing the buffer
    const remaining = flushBuf.current.splice(0)
    for (let i = 0; i < remaining.length; i += 30) {
      fetch('/api/browser-ingest', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ readings: remaining.slice(i, i + 30) }),
      }).catch(() => {})
    }
    flushBuf.current  = []
    lastTickMs.current  = 0
    lastStoreMs.current = 0
    setMicActive(false)
    setMicDb(null)
    setMicPoints([])
    setMicSaveError(null)
    setBands([])
    setTramScore({ score: 0, rolling: 0, squeal: 0, flange: 0 })
    bandHistoryRef.current = []
    setManualTags([])
    micPointsRef.current = []
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
      freqBufRef.current  = new Float32Array(analyser.frequencyBinCount) as Float32Array<ArrayBuffer>

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
        currentDbRef.current = db

        // Update live dB readout every frame
        setMicDb(db)

        // Update chart + spectrum at display rate (smooth ECG)
        if (tsMs - lastTickMs.current >= CHART_TICK_MS) {
          lastTickMs.current = tsMs
          if (db !== null) {
            setMicPoints(prev => {
              const cutoff = tsMs - HISTORY_MS
              return [...prev.filter(p => p.tsMs >= cutoff), { tsMs, ext: null, int: db }]
            })
          }
          // Frequency analysis with rolling ambient baseline
          if (freqBufRef.current) {
            node.getFloatFrequencyData(freqBufRef.current)
            const bv = computeBands(freqBufRef.current, actx.sampleRate)

            // Accumulate band history (60-second window at 250 ms rate)
            bandHistoryRef.current.push([...bv])
            if (bandHistoryRef.current.length > BASELINE_FRAMES) bandHistoryRef.current.shift()

            // Baseline = 20th-percentile per band (ambient floor, not skewed by tram passages)
            const baseline = BANDS.map((_, bi) => {
              if (bandHistoryRef.current.length < 4) return -80
              const col = bandHistoryRef.current.map(f => f[bi]).sort((a, b) => a - b)
              return col[Math.floor(col.length * 0.20)]
            })

            setBands(bv)
            setTramScore(computeTramScore(bv, baseline))
          }
        }

        // Write to DB at storage rate — 1 sample/s regardless of display rate
        if (db !== null && tsMs - lastStoreMs.current >= STORAGE_TICK_MS) {
          lastStoreMs.current = tsMs
          flushBuf.current.push({ ts: new Date(tsMs).toISOString(), db_raw: db })
        }

        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      // Background DB flush — reports errors visibly instead of swallowing them
      const doFlush = async () => {
        const batch = flushBuf.current.splice(0, 30)
        if (!batch.length) return
        try {
          const res = await fetch('/api/browser-ingest', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ readings: batch }),
          })
          if (res.ok) {
            setMicSaveError(null)
          } else {
            const err = await res.json().catch(() => ({}))
            setMicSaveError(`Save error ${res.status}: ${(err as {error?: string}).error ?? 'unknown'}`)
          }
        } catch (e) {
          setMicSaveError(`Save error: ${e instanceof Error ? e.message : 'network'}`)
        }
      }
      flushTimer.current = setInterval(doFlush, MIC_FLUSH_MS)

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
        <div className="flex items-center gap-2">
          {micActive && (
            <div className="flex flex-col items-center gap-0.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs gap-1 border-amber-500/50 text-amber-400 hover:bg-amber-500/10"
                onClick={tagTram}
                title="Tag tram passage now (keyboard: T)"
              >
                <Tag className="h-3 w-3" />
                Tag tram <kbd className="opacity-50 font-mono">[T]</kbd>
              </Button>
              {tagFlash && (
                <span className="text-[10px] text-amber-400 animate-pulse">Tagged!</span>
              )}
            </div>
          )}
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
            {micError     && <span className="text-xs text-destructive max-w-[200px] text-right">{micError}</span>}
          {micSaveError && <span className="text-xs text-orange-400 max-w-[200px] text-right">{micSaveError}</span>}
          </div>
        </div>
      </div>

      {/* Frequency spectrum — only visible when mic is active and bands are populated */}
      {micActive && bands.length === BANDS.length && (
        <div className="px-1 space-y-1">
          <div className="flex items-end gap-[3px] h-10">
            {bands.map((db, i) => {
              const fill = GROUP_COLOR[BANDS[i].group]
              const pct  = Math.max(0, Math.min(100, (db + 100) / 80 * 100))
              return (
                <div key={i} className="flex-1">
                  <div className="w-full rounded-sm" style={{ height: `${pct}%`, backgroundColor: fill, minHeight: 2 }} />
                </div>
              )
            })}
          </div>

          {/* Band labels */}
          <div className="flex gap-[3px]">
            {BANDS.map((b, i) => (
              <span key={i} className="flex-1 text-center text-[8px] text-muted-foreground leading-none">
                {b.label}
              </span>
            ))}
          </div>

          {/* Per-mechanism scores + combined tram score */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px]" style={{ color: GROUP_COLOR.rolling }}>
              Roll {tramScore.rolling}%
            </span>
            <span className="text-[10px]" style={{ color: GROUP_COLOR.squeal }}>
              Squeal {tramScore.squeal}%
            </span>
            <span className="text-[10px]" style={{ color: GROUP_COLOR.flange }}>
              Flange {tramScore.flange}%
            </span>
            <span
              className="ml-auto shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: tramScore.score >= 60 ? '#ef444422' : tramScore.score >= 30 ? '#eab30822' : '#64748b22',
                color:            tramScore.score >= 60 ? '#ef4444'   : tramScore.score >= 30 ? '#eab308'   : '#64748b',
              }}
            >
              Tram {tramScore.score}%
            </span>
          </div>
        </div>
      )}

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

            {/* ±20 s shaded band per tram */}
            {visibleTrams.map((dep, i) => (
              <ReferenceArea
                key={`band-${dep.line}-${dep.expected}-${i}`}
                x1={new Date(dep.expected).getTime() - TRAM_PAD_MS}
                x2={new Date(dep.expected).getTime() + TRAM_PAD_MS}
                fill={withAlpha(lineColor(dep.line), 0.22)}
                stroke={withAlpha(lineColor(dep.line), 0.5)}
                strokeWidth={1}
              />
            ))}

            {/* Exact departure line + label per tram */}
            {visibleTrams.map((dep, i) => (
              <ReferenceLine
                key={`vline-${dep.line}-${dep.expected}-${i}`}
                x={new Date(dep.expected).getTime()}
                stroke={lineColor(dep.line)}
                strokeWidth={1.5}
                label={{
                  value: `${dep.line} → ${dep.direction.split(' ').slice(0, 2).join(' ')}`,
                  position: 'insideTopRight',
                  fill: lineColor(dep.line),
                  fontSize: 9,
                  fontWeight: 700,
                }}
              />
            ))}

            {/* Manual tram tags — detected passage band + anchor line at tag moment */}
            {manualTags.filter(t => t.endMs >= domainMin && t.startMs <= domainMax).map((t, i) => (
              <ReferenceArea
                key={`tag-band-${t.tagMs}-${i}`}
                x1={t.startMs}
                x2={t.endMs}
                fill="rgba(251,191,36,0.15)"
                stroke="rgba(251,191,36,0.4)"
                strokeWidth={1}
              />
            ))}
            {manualTags.filter(t => t.tagMs >= domainMin && t.tagMs <= domainMax).map((t, i) => (
              <ReferenceLine
                key={`tag-line-${t.tagMs}-${i}`}
                x={t.tagMs}
                stroke="#fbbf24"
                strokeWidth={1.5}
                strokeDasharray="4 2"
                label={{ value: '✦ tagged', position: 'insideTopLeft', fill: '#fbbf24', fontSize: 9, fontWeight: 700 }}
              />
            ))}

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
        {manualTags.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-2 rounded-sm bg-amber-400/20 border border-amber-400/50" />
            Tagged passage ({manualTags.length})
          </span>
        )}
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
