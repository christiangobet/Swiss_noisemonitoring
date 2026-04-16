'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { formatZurichTime } from '@/lib/utils'
import { Train, AlertCircle, CheckCircle2 } from 'lucide-react'

interface LiveData {
  exterior: Array<{ ts: string; db_cal: number | null }>
  interior: Array<{ ts: string; db_cal: number | null }>
}

interface StatsData {
  active: { offset_db: number } | null
  sensors: {
    exterior: { online: boolean; last_seen: string | null }
    interior: { online: boolean; last_seen: string | null }
  }
}

export function TopBar() {
  const [live, setLive] = useState<LiveData | null>(null)
  const [calib, setCalib] = useState<StatsData | null>(null)
  const [lastTram, setLastTram] = useState<{ ts: string; tram_line: string; tram_dir: string } | null>(null)

  useEffect(() => {
    const fetchLive = async () => {
      try {
        const res = await fetch('/api/live')
        if (res.ok) setLive(await res.json())
      } catch { /* ignore */ }
    }
    const fetchCalib = async () => {
      try {
        const res = await fetch('/api/calibration')
        if (res.ok) setCalib(await res.json())
      } catch { /* ignore */ }
    }
    const fetchTram = async () => {
      try {
        const res = await fetch('/api/stats?hours=24')
        if (res.ok) {
          const data = await res.json()
          if (data.last_tram) setLastTram(data.last_tram)
        }
      } catch { /* ignore */ }
    }

    fetchLive()
    fetchCalib()
    fetchTram()

    const interval = setInterval(fetchLive, 2000)
    const calibInterval = setInterval(fetchCalib, 30000)
    return () => { clearInterval(interval); clearInterval(calibInterval) }
  }, [])

  const lastExt = live?.exterior?.at(-1)
  const lastInt = live?.interior?.at(-1)
  const extDb = lastExt?.db_cal
  const intDb = lastInt?.db_cal
  const delta = extDb != null && intDb != null ? extDb - intDb : null

  const extOnline = calib?.sensors?.exterior?.online ?? false
  const intOnline = calib?.sensors?.interior?.online ?? false
  const calibActive = calib?.active != null

  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-3 bg-card border-b border-border">
      {/* Exterior dB — large */}
      <div className="flex flex-col">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">Exterior</span>
        {extDb != null ? (
          <span className="font-db text-3xl font-bold text-amber-400 leading-tight">
            {extDb.toFixed(1)}
            <span className="text-sm font-normal text-muted-foreground ml-1">dB(A)</span>
          </span>
        ) : (
          <Skeleton className="h-8 w-24" />
        )}
      </div>

      <div className="h-10 w-px bg-border" />

      {/* Interior dB */}
      <div className="flex flex-col">
        <span className="text-xs text-muted-foreground uppercase tracking-wider">Interior</span>
        {intDb != null ? (
          <span className="font-db text-2xl font-semibold text-blue-400 leading-tight">
            {intDb.toFixed(1)}
            <span className="text-sm font-normal text-muted-foreground ml-1">dB(A)</span>
          </span>
        ) : (
          <Skeleton className="h-7 w-20" />
        )}
      </div>

      {/* Delta */}
      {delta != null && (
        <>
          <div className="h-10 w-px bg-border" />
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">Δ Attenuation</span>
            <span className="font-db text-xl font-semibold text-foreground leading-tight">
              {delta.toFixed(1)} dB
            </span>
          </div>
        </>
      )}

      <div className="flex-1" />

      {/* Last tram */}
      {lastTram && (
        <div className="flex items-center gap-2 text-sm">
          <Train className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            Line {lastTram.tram_line}
            {lastTram.tram_dir ? ` → ${lastTram.tram_dir}` : ''}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatZurichTime(lastTram.ts, 'time')}
          </span>
        </div>
      )}

      {/* Sensor status badges */}
      <div className="flex items-center gap-2">
        <Badge variant={extOnline ? 'success' : 'danger'} className="gap-1">
          {extOnline ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          Ext
        </Badge>
        <Badge variant={intOnline ? 'success' : 'danger'} className="gap-1">
          {intOnline ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          Int
        </Badge>
        <Badge variant={calibActive ? 'secondary' : 'warning'}>
          {calibActive ? 'Calibrated' : 'Uncalibrated'}
        </Badge>
      </div>
    </div>
  )
}
