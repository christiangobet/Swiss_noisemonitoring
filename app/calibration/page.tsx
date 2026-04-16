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

interface CalibrationData {
  active: {
    id: number
    created_at: string
    duration_sec: number
    ext_mean_db: number
    int_mean_db: number
    offset_db: number
    active: boolean
    notes: string | null
  } | null
  history: Array<{
    id: number
    created_at: string
    duration_sec: number
    ext_mean_db: number
    int_mean_db: number
    offset_db: number
    active: boolean
    notes: string | null
  }>
  sensors: {
    exterior: { online: boolean; last_seen: string | null }
    interior: { online: boolean; last_seen: string | null }
  }
}

interface LiveReading {
  ts: string
  db_cal: number | null
}

type WizardStep = 'idle' | 'instructions' | 'running' | 'results' | 'error'

interface SessionResult {
  offset_db: number
  ext_mean_db: number
  int_mean_db: number
  sample_count: number
  session_id: number
}

export default function CalibrationPage() {
  const [calibData, setCalibData] = useState<CalibrationData | null>(null)
  const [loading, setLoading] = useState(true)

  // Wizard state
  const [step, setStep] = useState<WizardStep>('idle')
  const [duration, setDuration] = useState(60)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [sessionStart, setSessionStart] = useState<Date | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [liveExt, setLiveExt] = useState<number | null>(null)
  const [liveInt, setLiveInt] = useState<number | null>(null)
  const [emergingOffset, setEmergingOffset] = useState<number | null>(null)
  const [result, setResult] = useState<SessionResult | null>(null)
  const [notes, setNotes] = useState('')
  const [wizardError, setWizardError] = useState('')

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
    const interval = setInterval(fetchCalib, 10000)
    return () => clearInterval(interval)
  }, [fetchCalib])

  // Live readings during calibration
  useEffect(() => {
    if (step !== 'running') {
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current)
      return
    }
    const poll = async () => {
      try {
        const res = await fetch('/api/live')
        if (!res.ok) return
        const data: { exterior: LiveReading[]; interior: LiveReading[] } = await res.json()
        const ext = data.exterior.at(-1)?.db_cal
        const int = data.interior.at(-1)?.db_cal
        setLiveExt(ext ?? null)
        setLiveInt(int ?? null)
        if (ext != null && int != null) setEmergingOffset(ext - int)
      } catch { /* ignore */ }
    }
    liveIntervalRef.current = setInterval(poll, 2000)
    poll()
    return () => { if (liveIntervalRef.current) clearInterval(liveIntervalRef.current) }
  }, [step])

  // Countdown timer
  useEffect(() => {
    if (step !== 'running' || !sessionStart) return
    const tick = () => {
      const elapsed = (Date.now() - sessionStart.getTime()) / 1000
      const remaining = Math.max(0, duration - elapsed)
      setCountdown(Math.ceil(remaining))
      if (remaining <= 0) {
        if (intervalRef.current) clearInterval(intervalRef.current)
        finishCalibration()
      }
    }
    intervalRef.current = setInterval(tick, 500)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [step, sessionStart, duration])

  const startCalibration = async () => {
    setWizardError('')
    try {
      const res = await fetch('/api/calibration/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_sec: duration }),
      })
      const data = await res.json()
      if (!res.ok) {
        setWizardError(data.error ?? 'Failed to start calibration')
        setStep('error')
        return
      }
      setSessionId(data.session_id)
      setSessionStart(new Date(data.started_at))
      setCountdown(duration)
      setStep('running')
    } catch (err) {
      setWizardError(String(err))
      setStep('error')
    }
  }

  const finishCalibration = async () => {
    if (!sessionId) return
    if (liveIntervalRef.current) clearInterval(liveIntervalRef.current)
    try {
      const res = await fetch('/api/calibration/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setWizardError(data.error ?? 'Failed to finish calibration')
        setStep('error')
        return
      }
      setResult(data)
      setStep('results')
    } catch (err) {
      setWizardError(String(err))
      setStep('error')
    }
  }

  const confirmCalibration = async () => {
    if (!result) return
    if (notes) {
      // Update notes via a direct API call if needed — for now just show success
    }
    toast({ title: 'Calibration saved', description: `Offset: ${result.offset_db.toFixed(1)} dB` })
    setStep('idle')
    setResult(null)
    setNotes('')
    setSessionId(null)
    fetchCalib()
  }

  const reactivate = async (id: number) => {
    try {
      const res = await fetch('/api/calibration/reactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calibration_id: id }),
      })
      if (res.ok) {
        toast({ title: 'Calibration reactivated' })
        fetchCalib()
      }
    } catch { /* ignore */ }
  }

  const sensors = calibData?.sensors
  const extOnline = sensors?.exterior?.online ?? false
  const intOnline = sensors?.interior?.online ?? false
  const bothOnline = extOnline && intOnline

  // Calibration health
  const active = calibData?.active
  const healthDrift = active && calibData
    ? Math.abs((emergingOffset ?? active.offset_db) - active.offset_db)
    : null
  const health = healthDrift == null ? null : healthDrift < 3 ? 'good' : healthDrift < 5 ? 'warn' : 'bad'

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Calibration</h1>

      {/* Status card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Calibration Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">Active Offset</span>
                  <span className="font-db text-2xl font-bold text-foreground">
                    {active ? `${active.offset_db.toFixed(2)} dB` : '—'}
                  </span>
                  {active && (
                    <span className="text-xs text-muted-foreground">
                      Since {formatZurichTime(active.created_at, 'date')}
                    </span>
                  )}
                </div>
                <div className="flex-1" />
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={extOnline ? 'success' : 'danger'} className="gap-1">
                      {extOnline ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                      Exterior
                    </Badge>
                    {sensors?.exterior?.last_seen && (
                      <span className="text-xs text-muted-foreground">
                        {formatZurichTime(sensors.exterior.last_seen, 'time')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={intOnline ? 'success' : 'danger'} className="gap-1">
                      {intOnline ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                      Interior
                    </Badge>
                    {sensors?.interior?.last_seen && (
                      <span className="text-xs text-muted-foreground">
                        {formatZurichTime(sensors.interior.last_seen, 'time')}
                      </span>
                    )}
                  </div>
                  {health && (
                    <Badge variant={health === 'good' ? 'success' : health === 'warn' ? 'warning' : 'danger'}>
                      {health === 'good' ? 'Calibration OK' : health === 'warn' ? 'Drifting' : 'Drift >5 dB'}
                    </Badge>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Wizard */}
      {step === 'idle' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New Calibration</CardTitle>
            <CardDescription>
              {!bothOnline
                ? 'Both sensors must be online to calibrate.'
                : 'Run a calibration session to correct the interior sensor offset.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => setStep('instructions')}
              disabled={!bothOnline}
            >
              Start Calibration Wizard
            </Button>
            {!bothOnline && (
              <p className="mt-2 text-sm text-destructive">
                {!extOnline && 'Exterior sensor offline. '}
                {!intOnline && 'Interior sensor offline.'}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step === 'instructions' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 1 — Preparation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
              <li>Place <strong className="text-foreground">both sensors</strong> in the same room, in open air.</li>
              <li>Keep sensors away from walls and corners (≥ 50 cm).</li>
              <li>Ensure <strong className="text-foreground">no tram is currently passing</strong>.</li>
              <li>Wait 10 seconds for readings to stabilise before starting.</li>
            </ol>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Duration</label>
              <div className="flex gap-2">
                {[30, 60, 120].map(d => (
                  <Button
                    key={d}
                    size="sm"
                    variant={duration === d ? 'default' : 'outline'}
                    onClick={() => setDuration(d)}
                  >
                    {d}s
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={startCalibration}>
                Start {duration}s Session
              </Button>
              <Button variant="outline" onClick={() => setStep('idle')}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'running' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 animate-pulse text-amber-400" />
              Step 2 — Recording…
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Progress value={((duration - countdown) / duration) * 100} />
            <p className="text-center font-db text-2xl font-bold text-amber-400">
              {countdown}s remaining
            </p>

            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-xs text-muted-foreground">Exterior</p>
                <p className="font-db text-xl text-amber-400">
                  {liveExt != null ? `${liveExt.toFixed(1)} dB` : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Interior</p>
                <p className="font-db text-xl text-blue-400">
                  {liveInt != null ? `${liveInt.toFixed(1)} dB` : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Emerging Offset</p>
                <p className="font-db text-xl text-foreground">
                  {emergingOffset != null ? `${emergingOffset.toFixed(1)} dB` : '—'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'results' && result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Step 3 — Review Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-xs text-muted-foreground">Exterior Mean</p>
                <p className="font-db text-xl text-amber-400">{result.ext_mean_db.toFixed(2)} dB</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Interior Mean</p>
                <p className="font-db text-xl text-blue-400">{result.int_mean_db.toFixed(2)} dB</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">New Offset</p>
                <p className="font-db text-xl font-bold text-foreground">{result.offset_db.toFixed(2)} dB</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{result.sample_count} samples recorded.</p>

            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. After moving mic to windowsill"
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={confirmCalibration}>Save Calibration</Button>
              <Button variant="outline" onClick={() => { setStep('idle'); setResult(null) }}>
                Discard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'error' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Calibration Failed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{wizardError}</p>
            <Button variant="outline" onClick={() => setStep('idle')}>
              <RotateCcw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
          </CardContent>
        </Card>
      )}

      {/* History table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Calibration History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : calibData?.history && calibData.history.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Date</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Offset</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Ext Mean</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Int Mean</th>
                    <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Notes</th>
                    <th className="text-center py-2 text-muted-foreground font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {calibData.history.map(c => (
                    <tr key={c.id} className="border-b border-border/50 hover:bg-accent/30">
                      <td className="py-2 pr-4 font-db text-xs text-muted-foreground">
                        {formatZurichTime(c.created_at, 'datetime')}
                      </td>
                      <td className="py-2 pr-4 text-right font-db font-semibold">
                        {c.offset_db.toFixed(2)} dB
                      </td>
                      <td className="py-2 pr-4 text-right font-db text-amber-400">
                        {c.ext_mean_db.toFixed(1)} dB
                      </td>
                      <td className="py-2 pr-4 text-right font-db text-blue-400">
                        {c.int_mean_db.toFixed(1)} dB
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground max-w-[200px] truncate">
                        {c.notes && !c.notes.startsWith('PENDING:') ? c.notes : '—'}
                      </td>
                      <td className="py-2 text-center">
                        {c.active ? (
                          <Badge variant="success">Active</Badge>
                        ) : !c.notes?.startsWith('PENDING:') ? (
                          <Button size="sm" variant="outline" onClick={() => reactivate(c.id)}>
                            Reactivate
                          </Button>
                        ) : (
                          <Badge variant="secondary">Pending</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No calibration sessions yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
