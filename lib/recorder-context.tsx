'use client'

/**
 * RecorderContext — global recording pipeline that persists across navigation.
 * Owns the browser mic (getUserMedia + AudioContext) and GM1356 WebHID pipelines.
 * Mount RecorderProvider at layout level so LiveChart can unmount without stopping recording.
 */

import {
  createContext, useContext, useRef, useState,
  useCallback, useEffect, type ReactNode,
} from 'react'

// ── Shared types ──────────────────────────────────────────────────────────────
export type ChartPoint = { tsMs: number; [source: string]: number | null | undefined }
export interface ManualTag { tagMs: number; startMs: number; endMs: number }
export interface TramScore { score: number; rolling: number; squeal: number; flange: number }

// ── Constants ─────────────────────────────────────────────────────────────────
const HISTORY_MS      = 3 * 60 * 1000
const CHART_TICK_MS   = 250
const STORAGE_TICK_MS = 1000
const LEQ_SMOOTH_N    = 4
const MIC_FLUSH_MS    = 5000
const DB_OFFSET       = 94
const BASELINE_FRAMES = 480

const BANDS = [
  { fMin:   45, fMax:   90 },
  { fMin:   90, fMax:  180 },
  { fMin:  180, fMax:  355 },
  { fMin:  355, fMax:  710 },
  { fMin:  710, fMax: 1400 },
  { fMin: 1400, fMax: 2800 },
  { fMin: 2800, fMax: 5600 },
  { fMin: 5600, fMax: 11200 },
]

// ── Helpers ───────────────────────────────────────────────────────────────────
function getRmsDb(analyser: AnalyserNode): number | null {
  const buf = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  const rms = Math.sqrt(sum / buf.length)
  if (rms < 1e-6) return null
  return 20 * Math.log10(rms) + DB_OFFSET
}

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

function computeTramScore(bands: number[], baseline: number[]): TramScore {
  if (baseline.length < BANDS.length) return { score: 0, rolling: 0, squeal: 0, flange: 0 }
  const elevDb = (idxs: number[]) => {
    const curLin = idxs.reduce((s, i) => s + Math.pow(10, bands[i]    / 10), 0)
    const basLin = idxs.reduce((s, i) => s + Math.pow(10, baseline[i] / 10), 0)
    if (basLin < 1e-30) return 0
    const dBAbove = 10 * Math.log10(curLin / basLin)
    return Math.round(Math.min(100, Math.max(0, dBAbove * 10)))
  }
  const rolling = elevDb([3, 4])
  const squeal  = elevDb([5, 6])
  const flange  = elevDb([7])
  return { score: Math.round(0.40 * squeal + 0.35 * rolling + 0.25 * flange), rolling, squeal, flange }
}

const PASSAGE_THRESHOLD_DB = 3.5
const PASSAGE_LOOK_MS      = 90_000

function detectPassageBounds(points: ChartPoint[], tagMs: number, source: string) {
  const window = points
    .filter(p => p[source] != null && p.tsMs >= tagMs - PASSAGE_LOOK_MS && p.tsMs <= tagMs + PASSAGE_LOOK_MS)
    .sort((a, b) => a.tsMs - b.tsMs)
  if (window.length < 4) return { startMs: tagMs - 5000, endMs: tagMs + 5000 }
  const sorted   = window.map(p => p[source] as number).sort((a, b) => a - b)
  const baseline = sorted[Math.floor(sorted.length * 0.15)]
  const threshold = baseline + PASSAGE_THRESHOLD_DB
  let nearestIdx = 0, nearestDist = Infinity
  for (let i = 0; i < window.length; i++) {
    const d = Math.abs(window[i].tsMs - tagMs)
    if (d < nearestDist) { nearestDist = d; nearestIdx = i }
  }
  let startIdx = nearestIdx, endIdx = nearestIdx
  for (let i = nearestIdx; i >= 0; i--) { if ((window[i][source] as number) < threshold) break; startIdx = i }
  for (let i = nearestIdx; i < window.length; i++) { if ((window[i][source] as number) < threshold) break; endIdx = i }
  return { startMs: Math.min(window[startIdx].tsMs, tagMs - 5000), endMs: Math.max(window[endIdx].tsMs, tagMs + 5000) }
}

// ── Context interface ─────────────────────────────────────────────────────────
interface RecorderCtx {
  // Mic state
  micActive:     boolean
  micDb:         number | null
  micPoints:     ChartPoint[]
  micSource:     string
  micError:      string | null
  micSaveError:  string | null
  lastSavedMs:   number | null
  savedCount:    number
  bands:         number[]
  tramScore:     TramScore
  manualTags:    ManualTag[]
  tagFlash:      boolean
  // Mic actions
  startMic:  () => Promise<void>
  stopMic:   () => void
  tagTram:   () => void
  setMicSource: (s: string) => void
  deviceLabel:    string
  setDeviceLabel: (v: string) => void
  // GM1356 state
  gm1356Active:      boolean
  gm1356Db:          number | null
  gm1356Peak:        number | null
  gm1356Points:      ChartPoint[]
  gm1356Source:      string
  gm1356Error:       string | null
  gm1356SaveError:   string | null
  gm1356LastSavedMs: number | null
  gm1356SavedCount:  number
  // GM1356 actions
  startGm1356: () => Promise<void>
  stopGm1356:  () => void
}

const Ctx = createContext<RecorderCtx | null>(null)

export function useRecorder(): RecorderCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useRecorder must be used inside RecorderProvider')
  return c
}

// ── Provider ──────────────────────────────────────────────────────────────────
export function RecorderProvider({ children }: { children: ReactNode }) {
  // ── Mic state ───────────────────────────────────────────────────────────────
  const [micActive,    setMicActive]    = useState(false)
  const [micDb,        setMicDb]        = useState<number | null>(null)
  const [micPoints,    setMicPoints]    = useState<ChartPoint[]>([])
  const [micSource,    setMicSourceSt]  = useState('default')
  const [micError,     setMicError]     = useState<string | null>(null)
  const [micSaveError, setMicSaveError] = useState<string | null>(null)
  const [lastSavedMs,  setLastSavedMs]  = useState<number | null>(null)
  const [savedCount,   setSavedCount]   = useState(0)
  const [bands,        setBands]        = useState<number[]>([])
  const [tramScore,    setTramScore]    = useState<TramScore>({ score: 0, rolling: 0, squeal: 0, flange: 0 })
  const [manualTags,   setManualTags]   = useState<ManualTag[]>([])
  const [tagFlash,     setTagFlash]     = useState(false)

  // ── GM1356 state ────────────────────────────────────────────────────────────
  const [gm1356Active,      setGm1356Active]      = useState(false)
  const [gm1356Db,          setGm1356Db]          = useState<number | null>(null)
  const [gm1356Peak,        setGm1356Peak]         = useState<number | null>(null)
  const [gm1356Points,      setGm1356Points]       = useState<ChartPoint[]>([])
  const [gm1356Source,      setGm1356SourceSt]     = useState('gm1356')
  const [gm1356Error,       setGm1356Error]        = useState<string | null>(null)
  const [gm1356SaveError,   setGm1356SaveError]    = useState<string | null>(null)
  const [gm1356LastSavedMs, setGm1356LastSavedMs]  = useState<number | null>(null)
  const [gm1356SavedCount,  setGm1356SavedCount]   = useState(0)

  const [deviceLabel, setDeviceLabelSt] = useState('')

  // ── Mic refs ─────────────────────────────────────────────────────────────────
  const streamRef       = useRef<MediaStream | null>(null)
  const ctxRef          = useRef<AudioContext | null>(null)
  const analyserRef     = useRef<AnalyserNode | null>(null)
  const freqBufRef      = useRef<Float32Array<ArrayBuffer> | null>(null)
  const rafRef          = useRef<number>(0)
  const flushTimer      = useRef<ReturnType<typeof setInterval> | null>(null)
  const flushBuf        = useRef<Array<{ ts: string; db_raw: number; tram_flag?: boolean }>>([])
  const lastTickMs      = useRef(0)
  const lastStoreMs     = useRef(0)
  const currentDbRef    = useRef<number | null>(null)
  const micPointsRef    = useRef<ChartPoint[]>([])
  const bandHistoryRef  = useRef<number[][]>([])
  const leqBufRef       = useRef<number[]>([])

  // ── GM1356 refs ──────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gm1356DeviceRef    = useRef<any>(null)
  const gm1356FlushBuf     = useRef<Array<{ ts: string; db_raw: number }>>([])
  const gm1356FlushTimer   = useRef<ReturnType<typeof setInterval> | null>(null)
  const gm1356PollRef      = useRef<ReturnType<typeof setInterval> | null>(null)
  const gm1356SourceRef    = useRef('gm1356')
  const gm1356PeakDecayRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Source identity ──────────────────────────────────────────────────────────
  const micSourceRef   = useRef('default')
  const deviceLabelRef = useRef('')
  const deviceIdRef    = useRef('')

  const setMicSource = useCallback((s: string) => {
    micSourceRef.current = s
    setMicSourceSt(s)
    localStorage.setItem('tramwatchSource', s)
  }, [])

  const setDeviceLabel = useCallback((v: string) => {
    deviceLabelRef.current = v
    setDeviceLabelSt(v)
    localStorage.setItem('tramwatchDeviceLabel', v)
  }, [])

  useEffect(() => {
    let id = localStorage.getItem('tramwatchDeviceId')
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
      localStorage.setItem('tramwatchDeviceId', id)
    }
    deviceIdRef.current = id
    const defaultSrc = id.replace(/-/g, '').slice(0, 8)
    const savedSrc = localStorage.getItem('tramwatchSource')
    const src = savedSrc || defaultSrc
    if (!savedSrc) localStorage.setItem('tramwatchSource', defaultSrc)
    micSourceRef.current = src
    setMicSourceSt(src)
    const label = localStorage.getItem('tramwatchDeviceLabel') ?? ''
    deviceLabelRef.current = label
    setDeviceLabelSt(label)
    const gm1356Src = localStorage.getItem('tramwatchGm1356Source') || 'gm1356'
    gm1356SourceRef.current = gm1356Src
    setGm1356SourceSt(gm1356Src)
  }, [])

  // Keep micPointsRef in sync for tagTram
  useEffect(() => { micPointsRef.current = micPoints }, [micPoints])

  // ── Mic stop ─────────────────────────────────────────────────────────────────
  const stopMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    if (flushTimer.current) clearInterval(flushTimer.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close().catch(() => {})
    streamRef.current = ctxRef.current = analyserRef.current = freqBufRef.current = null
    currentDbRef.current = null
    const remaining = flushBuf.current.splice(0)
    for (let i = 0; i < remaining.length; i += 30) {
      fetch('/api/browser-ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: micSourceRef.current, device_id: deviceIdRef.current,
          device_label: deviceLabelRef.current || undefined,
          readings: remaining.slice(i, i + 30),
        }),
      }).catch(() => {})
    }
    flushBuf.current = []; lastTickMs.current = 0; lastStoreMs.current = 0
    setMicActive(false); setMicDb(null); setMicPoints([]); setMicSaveError(null)
    setLastSavedMs(null); setSavedCount(0); setBands([])
    setTramScore({ score: 0, rolling: 0, squeal: 0, flange: 0 })
    bandHistoryRef.current = []; leqBufRef.current = []
    setManualTags([]); micPointsRef.current = []
  }, [])

  // Resume AudioContext on tab focus
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && ctxRef.current?.state === 'suspended') {
        ctxRef.current.resume().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // ── Mic start ────────────────────────────────────────────────────────────────
  const startMic = useCallback(async () => {
    setMicError(null)
    try {
      const savedId = localStorage.getItem('browserMicDeviceId')
      const stream  = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: savedId ? { ideal: savedId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      streamRef.current = stream
      const ctx      = new AudioContext()
      const src      = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.3
      src.connect(analyser)
      ctxRef.current = ctx; analyserRef.current = analyser
      freqBufRef.current = new Float32Array(analyser.frequencyBinCount) as Float32Array<ArrayBuffer>

      const tick = () => {
        const actx = ctxRef.current; const node = analyserRef.current
        if (!actx || !node) return
        if (actx.state === 'suspended') actx.resume().catch(() => {})
        const db   = getRmsDb(node)
        const tsMs = Date.now()
        currentDbRef.current = db
        setMicDb(db)
        if (tsMs - lastTickMs.current >= CHART_TICK_MS) {
          lastTickMs.current = tsMs
          if (db !== null) {
            leqBufRef.current.push(db)
            if (leqBufRef.current.length > LEQ_SMOOTH_N) leqBufRef.current.shift()
            const leq = 10 * Math.log10(
              leqBufRef.current.reduce((s, v) => s + Math.pow(10, v / 10), 0) / leqBufRef.current.length
            )
            const source = micSourceRef.current
            setMicPoints(prev => {
              const cutoff = tsMs - HISTORY_MS
              return [...prev.filter(p => p.tsMs >= cutoff), { tsMs, [source]: leq }]
            })
          }
          if (freqBufRef.current) {
            node.getFloatFrequencyData(freqBufRef.current)
            const bv = computeBands(freqBufRef.current, actx.sampleRate)
            bandHistoryRef.current.push([...bv])
            if (bandHistoryRef.current.length > BASELINE_FRAMES) bandHistoryRef.current.shift()
            const baseline = BANDS.map((_, bi) => {
              if (bandHistoryRef.current.length < 4) return -80
              const col = bandHistoryRef.current.map(f => f[bi]).sort((a, b) => a - b)
              return col[Math.floor(col.length * 0.10)]
            })
            setBands(bv); setTramScore(computeTramScore(bv, baseline))
          }
        }
        if (db !== null && tsMs - lastStoreMs.current >= STORAGE_TICK_MS) {
          lastStoreMs.current = tsMs
          flushBuf.current.push({ ts: new Date(tsMs).toISOString(), db_raw: db })
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      const doFlush = async () => {
        const batch = flushBuf.current.splice(0, 30)
        if (!batch.length) return
        try {
          const res = await fetch('/api/browser-ingest', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: micSourceRef.current, device_id: deviceIdRef.current, device_label: deviceLabelRef.current || undefined, readings: batch }),
          })
          if (res.ok) { setMicSaveError(null); setLastSavedMs(Date.now()); setSavedCount(n => n + batch.length) }
          else { const e = await res.json().catch(() => ({})); setMicSaveError(`Save error ${res.status}: ${(e as {error?: string}).error ?? 'unknown'}`) }
        } catch (e) { setMicSaveError(`Save error: ${e instanceof Error ? e.message : 'network'}`) }
      }
      flushTimer.current = setInterval(doFlush, MIC_FLUSH_MS)
      localStorage.setItem('tramwatchMicActive', 'true')
      setMicActive(true)
    } catch (e) { setMicError(e instanceof Error ? e.message : 'Microphone unavailable') }
  }, [])

  // Auto-start mic on mount if was active before
  useEffect(() => {
    if (localStorage.getItem('tramwatchMicActive') === 'true') startMic()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Tag tram passage ─────────────────────────────────────────────────────────
  const tagTram = useCallback(() => {
    const tagMs = Date.now()
    const src   = micSourceRef.current
    const { startMs, endMs } = detectPassageBounds(micPointsRef.current, tagMs, src)
    setManualTags(prev => [...prev.filter(t => t.tagMs >= tagMs - HISTORY_MS), { tagMs, startMs, endMs }])
    setTagFlash(true)
    setTimeout(() => setTagFlash(false), 1500)
    const passagePoints = micPointsRef.current.filter(p => p[src] != null && p.tsMs >= startMs && p.tsMs <= endMs)
    for (const p of passagePoints) {
      flushBuf.current.push({ ts: new Date(p.tsMs).toISOString(), db_raw: p[src] as number, tram_flag: true })
    }
    const db = currentDbRef.current
    if (db !== null && !passagePoints.some(p => Math.abs(p.tsMs - tagMs) < 500)) {
      flushBuf.current.push({ ts: new Date(tagMs).toISOString(), db_raw: db, tram_flag: true })
    }
  }, [])

  // ── GM1356 stop ──────────────────────────────────────────────────────────────
  const stopGm1356 = useCallback(() => {
    if (gm1356PollRef.current)    clearInterval(gm1356PollRef.current)
    if (gm1356FlushTimer.current) clearInterval(gm1356FlushTimer.current)
    gm1356PollRef.current = gm1356FlushTimer.current = null
    const remaining = gm1356FlushBuf.current.splice(0)
    if (remaining.length) {
      fetch('/api/browser-ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: gm1356SourceRef.current, readings: remaining }),
      }).catch(() => {})
    }
    const dev = gm1356DeviceRef.current
    if (dev) { dev.close().catch(() => {}); gm1356DeviceRef.current = null }
    if (gm1356PeakDecayRef.current) clearTimeout(gm1356PeakDecayRef.current)
    setGm1356Active(false); setGm1356Db(null); setGm1356Peak(null); setGm1356Points([])
    setGm1356SaveError(null); setGm1356LastSavedMs(null); setGm1356SavedCount(0)
    gm1356FlushBuf.current = []
  }, [])

  // ── GM1356 start ─────────────────────────────────────────────────────────────
  const startGm1356 = useCallback(async () => {
    setGm1356Error(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = navigator as any
    if (!nav.hid) { setGm1356Error('WebHID not supported — use Chrome or Edge'); return }
    try {
      const devices = await nav.hid.requestDevice({ filters: [{ vendorId: 0x64BD, productId: 0x74E3 }] })
      if (!devices.length) return
      const device = devices[0]
      await device.open()
      gm1356DeviceRef.current = device

      const decodeReport = (d: DataView): number | null => {
        if (d.byteLength < 3) return null
        const fromOffset = (o: number) => (d.getUint8(o) * 256 + d.getUint8(o + 1)) * 0.1
        let db = fromOffset(1)
        if (db < 20 || db > 140) db = fromOffset(0)
        return (db >= 20 && db <= 140) ? db : null
      }

      const handleReport = (db: number) => {
        const tsMs = Date.now()
        setGm1356Db(db)
        setGm1356Peak(prev => (prev === null || db > prev) ? db : prev)
        if (gm1356PeakDecayRef.current) clearTimeout(gm1356PeakDecayRef.current)
        gm1356PeakDecayRef.current = setTimeout(() => setGm1356Peak(null), 10_000)
        const src = gm1356SourceRef.current
        setGm1356Points(prev => [...prev.filter(p => p.tsMs >= tsMs - HISTORY_MS), { tsMs, [src]: db }])
        gm1356FlushBuf.current.push({ ts: new Date(tsMs).toISOString(), db_raw: db })
      }

      device.addEventListener('inputreport', (event: unknown) => {
        const db = decodeReport((event as { data: DataView }).data)
        if (db !== null) handleReport(db)
      })

      const poll = async () => {
        const dev = gm1356DeviceRef.current
        if (!dev?.opened) return
        try {
          const data = await dev.receiveFeatureReport(0)
          const db = decodeReport(data as DataView)
          if (db !== null) { handleReport(db); return }
        } catch { /* device doesn't use feature reports */ }
        dev.sendReport(0x00, new Uint8Array([0xB3, 0, 0, 0, 0, 0, 0, 0])).catch(() => {})
      }
      poll(); gm1356PollRef.current = setInterval(poll, 1000)

      const doFlush = async () => {
        const batch = gm1356FlushBuf.current.splice(0, 30)
        if (!batch.length) return
        try {
          const res = await fetch('/api/browser-ingest', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: gm1356SourceRef.current, readings: batch }),
          })
          if (res.ok) { setGm1356SaveError(null); setGm1356LastSavedMs(Date.now()); setGm1356SavedCount(n => n + batch.length) }
          else { const e = await res.json().catch(() => ({})); setGm1356SaveError(`Save error ${res.status}: ${(e as {error?: string}).error ?? 'unknown'}`) }
        } catch (e) { setGm1356SaveError(`Save error: ${e instanceof Error ? e.message : 'network'}`) }
      }
      gm1356FlushTimer.current = setInterval(doFlush, MIC_FLUSH_MS)
      setGm1356Active(true)
    } catch (e) { setGm1356Error(e instanceof Error ? e.message : 'Failed to connect') }
  }, [])

  // GM1356 disconnect handler
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = navigator as any
    if (!nav.hid) return
    const onDisconnect = (e: unknown) => {
      if ((e as { device: unknown }).device === gm1356DeviceRef.current) {
        stopGm1356(); setGm1356Error('SPL meter disconnected')
      }
    }
    nav.hid.addEventListener('disconnect', onDisconnect)
    return () => nav.hid.removeEventListener('disconnect', onDisconnect)
  }, [stopGm1356])

  const value: RecorderCtx = {
    micActive, micDb, micPoints, micSource, micError, micSaveError, lastSavedMs, savedCount,
    bands, tramScore, manualTags, tagFlash,
    startMic, stopMic, tagTram, setMicSource,
    deviceLabel, setDeviceLabel,
    gm1356Active, gm1356Db, gm1356Peak, gm1356Points, gm1356Source,
    gm1356Error, gm1356SaveError, gm1356LastSavedMs, gm1356SavedCount,
    startGm1356, stopGm1356,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
