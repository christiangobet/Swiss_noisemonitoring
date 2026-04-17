'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { formatZurichTime } from '@/lib/utils'
import { Train } from 'lucide-react'

const SOURCE_COLORS = ['#F59E0B', '#60A5FA', '#34D399', '#F87171', '#A78BFA', '#FB923C']

export function TopBar() {
  const [sources, setSources] = useState<Record<string, Array<{ ts: string; db_cal: number | null }>>>({})
  const [lastTram, setLastTram] = useState<{ ts: string; tram_line: string; tram_dir: string } | null>(null)
  const [calibrated, setCalibrated] = useState(false)

  useEffect(() => {
    const fetchLive = async () => {
      try {
        const res = await fetch('/api/live')
        if (res.ok) {
          const data = await res.json()
          setSources(data.sources ?? {})
        }
      } catch { /* ignore */ }
    }
    const fetchCalib = async () => {
      try {
        const res = await fetch('/api/calibration')
        if (res.ok) {
          const data = await res.json()
          setCalibrated((data.active_offsets ?? []).length > 0)
        }
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

    fetchLive(); fetchCalib(); fetchTram()
    const t1 = setInterval(fetchLive, 2000)
    const t2 = setInterval(fetchCalib, 30000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [])

  const srcNames = Object.keys(sources).sort()

  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-3 bg-card border-b border-border">
      {srcNames.map((src, i) => {
        const last = sources[src]?.at(-1)
        const db = last?.db_cal ?? null
        return (
          <div key={src} className="flex flex-col">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">{src}</span>
            {db != null ? (
              <span className="font-db text-2xl font-bold leading-tight" style={{ color: SOURCE_COLORS[i % SOURCE_COLORS.length] }}>
                {db.toFixed(1)}<span className="text-sm font-normal text-muted-foreground ml-1">dB(A)</span>
              </span>
            ) : (
              <span className="font-db text-2xl text-muted-foreground">—</span>
            )}
          </div>
        )
      })}

      <div className="flex-1" />

      {lastTram && (
        <div className="flex items-center gap-2 text-sm">
          <Train className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            Line {lastTram.tram_line}{lastTram.tram_dir ? ` → ${lastTram.tram_dir}` : ''}
          </span>
          <span className="text-xs text-muted-foreground">{formatZurichTime(lastTram.ts, 'time')}</span>
        </div>
      )}

      <Badge variant={calibrated ? 'secondary' : 'warning'}>
        {calibrated ? 'Calibrated' : 'Uncalibrated'}
      </Badge>
    </div>
  )
}
