'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Mic, MicOff } from 'lucide-react'

const DB_OFFSET       = 94
const STORAGE_TICK_MS = 1000
const FLUSH_MS        = 5000

function getRmsDb(analyser: AnalyserNode): number | null {
  const buf = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  const rms = Math.sqrt(sum / buf.length)
  if (rms < 1e-6) return null
  return 20 * Math.log10(rms) + DB_OFFSET
}

export function MicRecorder() {
  const [active,  setActive]  = useState(false)
  const [db,      setDb]      = useState<number | null>(null)
  const [source,  setSource]  = useState('default')
  const [error,   setError]   = useState<string | null>(null)

  const streamRef    = useRef<MediaStream | null>(null)
  const ctxRef       = useRef<AudioContext | null>(null)
  const analyserRef  = useRef<AnalyserNode | null>(null)
  const rafRef       = useRef<number>(0)
  const flushTimer   = useRef<ReturnType<typeof setInterval> | null>(null)
  const flushBuf     = useRef<Array<{ ts: string; db_raw: number }>>([])
  const lastStoreMs  = useRef<number>(0)
  const deviceIdRef  = useRef<string>('')
  const sourceRef    = useRef<string>('default')

  useEffect(() => {
    let id = localStorage.getItem('tramwatchDeviceId')
    if (!id) {
      id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)
      localStorage.setItem('tramwatchDeviceId', id)
    }
    deviceIdRef.current = id
    const defaultSrc = id.replace(/-/g, '').slice(0, 8)
    const saved = localStorage.getItem('tramwatchSource') ?? defaultSrc
    sourceRef.current = saved
    setSource(saved)
  }, [])

  const stopMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    if (flushTimer.current) clearInterval(flushTimer.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close().catch(() => {})
    streamRef.current = ctxRef.current = analyserRef.current = null
    // flush remaining
    const remaining = flushBuf.current.splice(0)
    for (let i = 0; i < remaining.length; i += 30) {
      fetch('/api/browser-ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source:    sourceRef.current,
          device_id: deviceIdRef.current,
          readings:  remaining.slice(i, i + 30),
        }),
      }).catch(() => {})
    }
    flushBuf.current = []
    lastStoreMs.current = 0
    setActive(false)
    setDb(null)
  }, [])

  useEffect(() => stopMic, [stopMic])

  const startMic = useCallback(async () => {
    setError(null)
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
      const ctx      = new AudioContext()
      const src      = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 4096
      analyser.smoothingTimeConstant = 0.3
      src.connect(analyser)
      ctxRef.current     = ctx
      analyserRef.current = analyser

      const tick = () => {
        const node = analyserRef.current
        if (!node) return
        const level = getRmsDb(node)
        setDb(level)
        const tsMs = Date.now()
        if (level !== null && tsMs - lastStoreMs.current >= STORAGE_TICK_MS) {
          lastStoreMs.current = tsMs
          flushBuf.current.push({ ts: new Date(tsMs).toISOString(), db_raw: level })
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      const doFlush = async () => {
        const batch = flushBuf.current.splice(0, 30)
        if (!batch.length) return
        await fetch('/api/browser-ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source:    sourceRef.current,
            device_id: deviceIdRef.current,
            readings:  batch,
          }),
        }).catch(() => {})
      }
      flushTimer.current = setInterval(doFlush, FLUSH_MS)

      setActive(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Microphone unavailable')
    }
  }, [])

  const dbColor = db === null ? '' : db >= 75 ? '#f87171' : db >= 60 ? '#fbbf24' : '#4ade80'

  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        variant={active ? 'destructive' : 'outline'}
        className="h-7 px-2 text-xs gap-1"
        onClick={active ? stopMic : startMic}
      >
        {active ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
        {active ? 'Stop mic' : 'Use mic'}
      </Button>
      {active && db !== null && (
        <span className="font-mono text-xl font-bold tabular-nums" style={{ color: dbColor }}>
          {db.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">dB(A)</span>
        </span>
      )}
      {active && (
        <span className="text-xs text-muted-foreground">→ recording as <strong>{source}</strong></span>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
