'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { formatZurichTime } from '@/lib/utils'
import { CheckCircle2, AlertCircle, Clock, RotateCcw } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

interface ActiveOffset {
  source: string
  offset_db: number
  created_at: string
  session_id: number
}

interface SessionSource {
  source: string
  mean_db: number
  offset_db: number
  sample_count: number
  active: boolean
}

interface Session {
  id: number
  started_at: string
  duration_sec: number
  ref_source: string
  status: string
  notes: string | null
  sources: SessionSource[] | null
}

interface CalibData {
  active_offsets: ActiveOffset[]
  sessions: Session[]
  active_sources: string[]
}

interface SourceResult {
  source: string
  mean_db: number
  offset_db: number
  sample_count: number
}

interface FinishResult {
  session_id: number
  ref_source: string
  sources: SourceResult[]
}

type WizardStep = 'idle' | 'setup' | 'running' | 'results' | 'error'

export default function CalibrationPage() {
  const [calibData, setCalibData] = useState<CalibData | null>(null)
  const [loading, setLoading] = useState(true)

  const [step, setStep] = useState<WizardStep>('idle')
  const [refSource, setRefSource] = useState('')
  const [duration, setDuration] = useState(60)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [sessionStart, setSessionStart] = useState<Date | null>(null)
  const [runSources, setRunSources] = useState<string[]>([])
  const [countdown, setCountdown] = useState(0)
  const [liveReadings, setLiveReadings] = useState<Record<string, number | null>>({})
  const [result, setResult] = useState<FinishResult | null>(null)
  const [wizardError, setWizardError] = useState('')

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const liveRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const finishCalledRef = useRef(false)

  const fetchCalib = useCallback(async () => {
    try {
      const res = await fetch('/api/calibration')
      if (res.ok) {
        setCalibData(await res.json())
        setLoading(false)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchCalib()
    const id = setInterval(fetchCalib, 10000)
    return () => clearInterval(id)
  }, [fetchCalib])

  // Live readings during calibration
  useEffect(() => {
    if (step !== 'running') {
      if (liveRef.current) clearInterval(liveRef.current)
      return
    }
    const poll = async () => {
      try {
        const res = await fetch('/api/live')
        if (!res.ok) return
        const data: { sources: Record<string, Array<{ db_cal: number | null }>> } = await res.json()
        const readings: Record<string, number | null> = {}
        for (const [src, rows] of Object.entries(data.sources)) {
          readings[src] = rows.at(-1)?.db_cal ?? null
        }
        setLiveReadings(readings)
      } catch { /* ignore */ }
    }
    liveRef.current = setInterval(poll, 2000)
    poll()
    return () => { if (liveRef.current) clearInterval(liveRef.current) }
  }, [step])

  const finishCalibration = useCallback(async (sid: number) => {
    if (finishCalledRef.current) return
    finishCalledRef.current = true
    if (liveRef.current) clearInterval(liveRef.current)
    if (countdownRef.current) clearInterval(countdownRef.current)
    try {
      const res = await fetch('/api/calibration/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid }),
      })
      const data = await res.json()
      if (!res.ok) {
        setWizardError(data.error ?? 'Failed to finish calibration')
        setStep('error')
        return
      }
      setResult(data as FinishResult)
      setStep('results')
    } catch (err) {
      setWizardError(String(err))
      setStep('error')
    }
  }, [])

  // Countdown timer
  useEffect(() => {
    if (step !== 'running' || !sessionStart || sessionId === null) return
    finishCalledRef.current = false
    const sid = sessionId
    const tick = () => {
      const elapsed = (Date.now() - sessionStart.getTime()) / 1000
      const remaining = Math.max(0, duration - elapsed)
      setCountdown(Math.ceil(remaining))
      if (remaining <= 0) {
        if (countdownRef.current) clearInterval(countdownRef.current)
        finishCalibration(sid)
      }
    }
    countdownRef.current = setInterval(tick, 500)
    tick()
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [step, sessionStart, duration, sessionId, finishCalibration])

  const startCalibration = async () => {
    setWizardError('')
    try {
      const res = await fetch('/api/calibration/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref_source: refSource, duration_sec: duration }),
      })
      const data = await res.json()
      if (!res.ok) {
        setWizardError(data.error ?? 'Failed to start calibration')
        setStep('error')
        return
      }
      setSessionId(data.session_id)
      setSessionStart(new Date(data.started_at))
      setRunSources(data.active_sources ?? [])
      setCountdown(duration)
      setLiveReadings({})
      setStep('running')
    } catch (err) {
      setWizardError(String(err))
      setStep('error')
    }
  }

  const reactivate = async (sid: number) => {
    try {
      const res = await fetch('/api/calibration/reactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid }),
      })
      if (res.ok) {
        toast({ title: 'Calibration reactivated' })
        fetchCalib()
      } else {
        const data = await res.json()
        toast({ title: 'Error', description: data.error, variant: 'destructive' })
      }
    } catch { /* ignore */ }
  }

  const reset = () => {
    setStep('idle')
    setResult(null)
    setSessionId(null)
    setWizardError('')
    fetchCalib()
  }

  const sourceOptions = calibData?.active_sources ?? []
  const canStart = sourceOptions.length >= 2 && !!refSource && sourceOptions.includes(refSource)
  const colCount = (n: number) => Math.min(n, 4)

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Calibration</h1>

      {/* Active offsets */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Active Offsets
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : calibData?.active_offsets && calibData.active_offsets.length > 0 ? (
            <div className="flex flex-wrap gap-6">
              {calibData.active_offsets.map(o => (
                <div key={o.source}>
                  <p className="text-xs text-muted-foreground">{o.source}</p>
                  <p className="font-db text-2xl font-bold text-foreground">
                    {o.offset_db >= 0 ? '+' : ''}{o.offset_db.toFixed(2)} dB
                  </p>
                  <p className="text-xs text-muted-foreground">{formatZurichTime(o.created_at, 'date')}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No active calibration offsets.</p>
          )}
        </CardContent>
      </Card>

      {/* Idle: source picker + start */}
      {step === 'idle' && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Active Sources
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton className="h-8 w-full" /> : sourceOptions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {sourceOptions.map(s => (
                    <Badge key={s} variant="success" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" />{s}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="h-4 w-4 text-destructive" />
                  No active sources in the last 30s.
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">New Calibration</CardTitle>
              <CardDescription>
                Place 2+ devices next to each other recording the same ambient sound, then pick a reference.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {sourceOptions.length < 2 ? (
                <p className="text-sm text-destructive">
                  Need ≥2 active sources. Currently {sourceOptions.length} active.
                </p>
              ) : (
                <>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Reference source</label>
                    <div className="flex flex-wrap gap-2">
                      {sourceOptions.map(s => (
                        <Button key={s} size="sm" variant={refSource === s ? 'default' : 'outline'} onClick={() => setRefSource(s)}>
                          {s}
                        </Button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      All other sources are calibrated relative to this one (its offset will be 0).
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">Duration</label>
                    <div className="flex gap-2">
                      {[30, 60, 120].map(d => (
                        <Button key={d} size="sm" variant={duration === d ? 'default' : 'outline'} onClick={() => setDuration(d)}>
                          {d}s
                        </Button>
                      ))}
                    </div>
                  </div>
                  <Button onClick={() => setStep('setup')} disabled={!refSource}>Continue →</Button>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Setup: instructions */}
      {step === 'setup' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 1 — Preparation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
              <li>Place <strong className="text-foreground">all devices</strong> in the same location, in open air.</li>
              <li>Keep devices ≥ 50 cm from walls and corners.</li>
              <li>Ensure <strong className="text-foreground">no tram is currently passing</strong>.</li>
              <li>Wait 10 s for readings to stabilise before starting.</li>
            </ol>
            <p className="text-sm">
              Reference: <Badge variant="secondary">{refSource}</Badge>
              &nbsp;·&nbsp;Duration: <strong>{duration}s</strong>
            </p>
            <div className="flex gap-2">
              <Button onClick={startCalibration} disabled={!canStart}>Start {duration}s Session</Button>
              <Button variant="outline" onClick={() => setStep('idle')}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Running */}
      {step === 'running' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 animate-pulse text-amber-400" />
              Recording…
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={((duration - countdown) / duration) * 100} />
            <p className="text-center font-db text-2xl font-bold text-amber-400">{countdown}s remaining</p>
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: `repeat(${colCount(runSources.length)}, minmax(0, 1fr))` }}
            >
              {runSources.map(src => (
                <div key={src} className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">
                    {src}{src === refSource ? ' (ref)' : ''}
                  </p>
                  <p className={`font-db text-xl ${src === refSource ? 'text-amber-400' : 'text-blue-400'}`}>
                    {liveReadings[src] != null ? `${(liveReadings[src] as number).toFixed(1)} dB` : '—'}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {step === 'results' && result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Results</CardTitle>
            <CardDescription>Reference: <strong>{result.ref_source}</strong></CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${colCount(result.sources.length)}, minmax(0, 1fr))` }}
            >
              {result.sources.map(s => (
                <div key={s.source} className="text-center border border-border rounded-md p-3">
                  <p className="text-xs text-muted-foreground mb-1">
                    {s.source}{s.source === result.ref_source ? ' (ref)' : ''}
                  </p>
                  <p className="font-db text-xs text-muted-foreground">{s.mean_db.toFixed(1)} dB mean</p>
                  <p className={`font-db text-xl font-bold ${s.source === result.ref_source ? 'text-muted-foreground' : 'text-foreground'}`}>
                    {s.offset_db >= 0 ? '+' : ''}{s.offset_db.toFixed(2)} dB
                  </p>
                  <p className="text-xs text-muted-foreground">{s.sample_count} samples</p>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => { toast({ title: 'Calibration saved', description: `${result.sources.length} sources calibrated` }); reset() }}>
                Done
              </Button>
              <Button variant="outline" onClick={reset}>Discard</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {step === 'error' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Calibration Failed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{wizardError}</p>
            <Button variant="outline" onClick={reset}>
              <RotateCcw className="h-4 w-4 mr-2" />Try Again
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Session history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Calibration History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : calibData?.sessions && calibData.sessions.length > 0 ? (
            <div className="space-y-3">
              {calibData.sessions.map(session => {
                const isActive = session.sources?.some(s => s.active) ?? false
                const validSources = session.sources?.filter(Boolean) ?? []
                return (
                  <div key={session.id} className="border border-border rounded-md p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-xs text-muted-foreground">
                          {formatZurichTime(session.started_at, 'datetime')}
                          {' · '}{session.duration_sec}s{' · '}ref: <strong>{session.ref_source}</strong>
                        </p>
                        {session.notes && <p className="text-xs text-muted-foreground">{session.notes}</p>}
                      </div>
                      {isActive ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => reactivate(session.id)}>
                          Reactivate
                        </Button>
                      )}
                    </div>
                    {validSources.length > 0 && (
                      <div className="flex flex-wrap gap-4">
                        {validSources.map(s => (
                          <div key={s.source} className="text-center">
                            <p className="text-xs text-muted-foreground">
                              {s.source}{s.source === session.ref_source ? ' (ref)' : ''}
                            </p>
                            <p className="font-db text-sm font-semibold">
                              {s.offset_db >= 0 ? '+' : ''}{s.offset_db.toFixed(2)} dB
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No calibration sessions yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
