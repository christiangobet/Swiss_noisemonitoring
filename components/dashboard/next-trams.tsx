'use client'

import { useEffect, useState } from 'react'

interface TramDep {
  line: string
  direction: string
  expected: string
}

const LINE_COLORS: Record<string, string> = {
  '2':  '#f97316', '3':  '#ef4444', '4':  '#8b5cf6', '5':  '#06b6d4',
  '6':  '#22c55e', '7':  '#a855f7', '8':  '#3b82f6', '9':  '#eab308',
  '10': '#14b8a6', '11': '#ec4899', '12': '#84cc16', '13': '#f43f5e',
  '14': '#64748b', '15': '#d97706',
}
function lineColor(line: string) { return LINE_COLORS[line] ?? '#94a3b8' }

function fmtCountdown(diffS: number): string {
  if (diffS <= 0) return 'now'
  const m = Math.floor(diffS / 60)
  const s = diffS % 60
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`
}

export function NextTrams() {
  const [schedule, setSchedule] = useState<TramDep[]>([])
  const [nowMs,    setNowMs]    = useState(Date.now())

  useEffect(() => {
    const fetchSchedule = async () => {
      try {
        const res = await fetch('/api/tram-schedule')
        if (res.ok) {
          const data = await res.json()
          setSchedule(data.departures ?? [])
        }
      } catch { /* non-fatal */ }
    }

    fetchSchedule()
    const t1 = setInterval(fetchSchedule, 30000)  // refresh schedule
    const t2 = setInterval(() => setNowMs(Date.now()), 1000)  // tick countdown
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [])

  // Show departures up to 20 min ahead; keep a tram visible for 15s after it was due
  const upcoming = schedule
    .map(d => ({ ...d, diffS: Math.round((new Date(d.expected).getTime() - nowMs) / 1000) }))
    .filter(d => d.diffS > -15 && d.diffS < 20 * 60)
    .slice(0, 8)

  if (upcoming.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2 border-b border-border bg-card/60 text-sm">
      {upcoming.map((dep, i) => {
        const color   = lineColor(dep.line)
        const past    = dep.diffS < 0
        const urgent  = dep.diffS >= 0 && dep.diffS < 30
        const dir     = dep.direction.split(' ').slice(0, 2).join(' ')

        return (
          <div
            key={`${dep.line}-${dep.expected}-${i}`}
            className={`flex items-center gap-1.5 transition-opacity ${past ? 'opacity-30' : 'opacity-100'}`}
          >
            {/* Line badge */}
            <span
              className="inline-flex items-center justify-center w-6 h-5 rounded text-[10px] font-bold leading-none"
              style={{ backgroundColor: color + '33', color }}
            >
              {dep.line}
            </span>

            {/* Direction */}
            <span className="text-muted-foreground text-xs max-w-[90px] truncate">{dir}</span>

            {/* Countdown */}
            <span
              className={`font-mono text-xs font-bold tabular-nums ${
                urgent ? 'text-red-400 animate-pulse' : past ? 'text-muted-foreground' : 'text-foreground'
              }`}
            >
              {fmtCountdown(dep.diffS)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
