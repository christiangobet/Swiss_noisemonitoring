'use client'

import { useEffect, useState } from 'react'
import { Train } from 'lucide-react'

interface TramDep {
  line: string
  direction: string
  expected: string
}

interface Group {
  line: string
  direction: string
  nexts: number[]   // sorted diffS values (seconds until departure)
}

const LINE_COLORS: Record<string, string> = {
  '2':  '#f97316', '3':  '#ef4444', '4':  '#8b5cf6', '5':  '#06b6d4',
  '6':  '#22c55e', '7':  '#a855f7', '8':  '#3b82f6', '9':  '#eab308',
  '10': '#14b8a6', '11': '#ec4899', '12': '#84cc16', '13': '#f43f5e',
  '14': '#64748b', '15': '#d97706',
}
function lineColor(line: string) { return LINE_COLORS[line] ?? '#94a3b8' }

function fmtSec(diffS: number): string {
  if (diffS <= 0)  return 'now'
  if (diffS < 60)  return `${diffS}s`
  const m = Math.floor(diffS / 60)
  const s = diffS % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

export function NextTrams() {
  const [schedule,  setSchedule]  = useState<TramDep[]>([])
  const [noStop,    setNoStop]    = useState(false)
  const [nowMs,     setNowMs]     = useState(Date.now())

  useEffect(() => {
    const fetchSchedule = async () => {
      try {
        const res = await fetch('/api/tram-schedule')
        if (!res.ok) return
        const data = await res.json()
        setSchedule(data.departures ?? [])
        setNoStop((data.departures ?? []).length === 0 && !!data.message)
      } catch { /* non-fatal */ }
    }

    fetchSchedule()
    const t1 = setInterval(fetchSchedule, 30000)
    const t2 = setInterval(() => setNowMs(Date.now()), 1000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [])

  // Group by line + direction, keeping departures up to 20 min ahead
  const groups: Group[] = []
  const seen = new Map<string, Group>()
  for (const dep of schedule) {
    const diffS = Math.round((new Date(dep.expected).getTime() - nowMs) / 1000)
    if (diffS < -20 || diffS > 20 * 60) continue
    const key = `${dep.line}::${dep.direction}`
    if (!seen.has(key)) {
      const g: Group = { line: dep.line, direction: dep.direction, nexts: [] }
      seen.set(key, g)
      groups.push(g)
    }
    seen.get(key)!.nexts.push(diffS)
  }
  // Sort groups: earliest first departure first
  groups.sort((a, b) => (a.nexts[0] ?? 999999) - (b.nexts[0] ?? 999999))

  if (noStop || groups.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card/60 text-xs text-muted-foreground">
        <Train className="h-3 w-3 shrink-0" />
        {noStop
          ? 'No tram stop configured — go to Settings to set one up.'
          : 'Fetching tram schedule…'}
      </div>
    )
  }

  return (
    <div className="border-b border-border bg-card/60">
      <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${Math.min(groups.length, 4)}, minmax(0,1fr))` }}>
        {groups.map(g => {
          const color   = lineColor(g.line)
          const first   = g.nexts[0] ?? null
          const second  = g.nexts[1] ?? null
          const urgent  = first !== null && first >= 0 && first < 30
          const passing = first !== null && first < 0

          return (
            <div
              key={`${g.line}-${g.direction}`}
              className="flex flex-col gap-0.5 px-3 py-2"
              style={{ borderLeft: `2px solid ${color}` }}
            >
              {/* Line + direction */}
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-black leading-none shrink-0"
                  style={{ backgroundColor: color + '30', color }}
                >
                  {g.line}
                </span>
                <span className="text-xs text-muted-foreground truncate leading-tight">
                  {g.direction}
                </span>
              </div>

              {/* Countdowns */}
              <div className="flex items-baseline gap-2 pl-0.5">
                {first !== null && (
                  <span
                    className={`font-mono text-sm font-bold tabular-nums leading-none ${
                      passing  ? 'text-muted-foreground line-through' :
                      urgent   ? 'text-red-400 animate-pulse' :
                                 'text-foreground'
                    }`}
                  >
                    {fmtSec(first)}
                  </span>
                )}
                {second !== null && (
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {fmtSec(second)}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
