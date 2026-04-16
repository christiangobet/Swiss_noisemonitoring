'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Mic, MicOff, RefreshCw } from 'lucide-react'

const SAMPLE_INTERVAL_MS = 200   // one reading every 200 ms
const FLUSH_INTERVAL_MS  = 2000  // push to DB every 2 s (max 10 readings/flush)
const DB_OFFSET          = 94    // dBFS → approximate dBSPL (corrected later by calibration)

function rmsToDb(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  const rms = Math.sqrt(sum / buf.length)
  return 20 * Math.log10(Math.max(rms, 1e-10)) + DB_OFFSET
}

export function BrowserMicCard() {
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown')
  const [devices,    setDevices]    = useState<MediaDeviceInfo[]>([])
  const [deviceId,   setDeviceId]   = useState<string>('')
  const [active,     setActive]     = useState(false)
  const [currentDb,  setCurrentDb]  = useState<number | null>(null)
  const [error,      setError]      = useState<string | null>(null)

  const streamRef   = useRef<MediaStream | null>(null)
  const ctxRef      = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const bufRef      = useRef<Array<{ ts: string; db_raw: number }>>([])
  const sampleTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const flushTimer  = useRef<ReturnType<typeof setInterval> | null>(null)

  const enumerateDevices = useCallback(async () => {
    try {
      const all    = await navigator.mediaDevices.enumerateDevices()
      const inputs = all.filter(d => d.kind === 'audioinput')
      setDevices(inputs)
      if (inputs.length > 0) {
        const saved = typeof window !== 'undefined' ? localStorage.getItem('browserMicDeviceId') : null
        const valid = saved && inputs.some(d => d.deviceId === saved)
        setDeviceId(valid ? saved! : inputs[0].deviceId)
      }
    } catch { /* permission not yet granted */ }
  }, [])

  // Check permission on mount
  useEffect(() => {
    if (typeof navigator === 'undefined') return
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then(p => {
        if (p.state === 'granted') { setPermission('granted'); enumerateDevices() }
        else if (p.state === 'denied') setPermission('denied')
        p.onchange = () => {
          if (p.state === 'granted') { setPermission('granted'); enumerateDevices() }
          else if (p.state === 'denied') setPermission('denied')
        }
      })
      .catch(() => { /* permissions API not available */ })

    return () => stopMonitoring()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const requestPermission = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach(t => t.stop())
      setPermission('granted')
      setError(null)
      await enumerateDevices()
    } catch {
      setPermission('denied')
      setError('Microphone access denied. Allow it in your browser settings.')
    }
  }

  const stopMonitoring = () => {
    if (sampleTimer.current) clearInterval(sampleTimer.current)
    if (flushTimer.current)  clearInterval(flushTimer.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close().catch(() => {})
    streamRef.current   = null
    ctxRef.current      = null
    analyserRef.current = null
    bufRef.current      = []
    setActive(false)
    setCurrentDb(null)
  }

  const startMonitoring = async () => {
    setError(null)
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId:         deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
        },
      }
      const stream  = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream

      const ctx     = new AudioContext()
      ctxRef.current = ctx
      const source  = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 4096
      source.connect(analyser)
      analyserRef.current = analyser

      // Sample loop
      sampleTimer.current = setInterval(() => {
        if (!analyserRef.current) return
        const db = rmsToDb(analyserRef.current)
        setCurrentDb(db)
        bufRef.current.push({ ts: new Date().toISOString(), db_raw: Math.max(0, db) })
      }, SAMPLE_INTERVAL_MS)

      // Flush loop
      flushTimer.current = setInterval(async () => {
        const batch = bufRef.current.splice(0, 30)
        if (batch.length === 0) return
        try {
          await fetch('/api/browser-ingest', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ readings: batch }),
          })
        } catch { /* non-fatal */ }
      }, FLUSH_INTERVAL_MS)

      // Save chosen device
      localStorage.setItem('browserMicDeviceId', deviceId)
      setActive(true)
    } catch (e) {
      setError(`Could not open microphone: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const dbColor = (db: number | null) => {
    if (db === null) return 'text-muted-foreground'
    if (db >= 75) return 'text-red-400'
    if (db >= 60) return 'text-amber-400'
    return 'text-green-400'
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Mic className="h-4 w-4 text-muted-foreground" />
          Browser Microphone
        </CardTitle>
        <CardDescription>
          Use this device&apos;s microphone as the interior sensor.
          Raw values are approximate — run a calibration session for accuracy.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {permission === 'unknown' && (
          <Button size="sm" onClick={requestPermission}>
            <Mic className="h-4 w-4 mr-2" />
            Allow microphone access
          </Button>
        )}

        {permission === 'denied' && (
          <p className="text-sm text-destructive">
            Microphone access denied. Enable it in your browser/OS settings and reload.
          </p>
        )}

        {permission === 'granted' && (
          <>
            {/* Device selector */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Input device</label>
              <div className="flex gap-2">
                <select
                  value={deviceId}
                  onChange={e => setDeviceId(e.target.value)}
                  disabled={active}
                  className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm
                             text-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                >
                  {devices.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Microphone ${d.deviceId.slice(0, 8)}…`}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={enumerateDevices}
                  disabled={active}
                  title="Refresh device list"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Live level + controls */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {active ? (
                  <>
                    <span className={`font-mono text-2xl font-bold tabular-nums ${dbColor(currentDb)}`}>
                      {currentDb !== null ? `${currentDb.toFixed(1)}` : '—'}
                    </span>
                    <span className="text-xs text-muted-foreground">dB(A) raw</span>
                    <Badge variant="outline" className="text-green-400 border-green-400/40 text-xs">
                      Live
                    </Badge>
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">Not monitoring</span>
                )}
              </div>

              <Button
                size="sm"
                variant={active ? 'destructive' : 'default'}
                onClick={active ? stopMonitoring : startMonitoring}
              >
                {active
                  ? <><MicOff className="h-4 w-4 mr-2" />Stop</>
                  : <><Mic className="h-4 w-4 mr-2" />Start monitoring</>}
              </Button>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <p className="text-xs text-muted-foreground">
              Readings flush to the database every 2 s as &ldquo;interior&rdquo; source.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
