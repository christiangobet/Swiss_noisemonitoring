'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { NOISE_LIMITS } from '@/lib/db'
import { formatDb, dbColor } from '@/lib/utils'
import { TrendingDown, Train, AlertTriangle, Wind } from 'lucide-react'

interface StatsData {
  day_leq_ext: number | null
  night_leq_ext: number | null
  day_leq_int: number | null
  night_leq_int: number | null
  attenuation_mean_db: number | null
  tram_events_count: number
  last_tram: { ts: string; tram_line: string; tram_dir: string } | null
  exceedance_minutes_day: number
  exceedance_minutes_night: number
  by_line: Array<{ line: string; headsign: string; count: number; mean_db_ext: number }>
}

function StatCard({
  title,
  value,
  unit,
  sub,
  icon: Icon,
  color,
}: {
  title: string
  value: string | null
  unit?: string
  sub?: string
  icon: React.ElementType
  color?: string
}) {
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {value == null ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <div className="font-db text-2xl font-bold" style={{ color: color ?? 'inherit' }}>
              {value}
              {unit && <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>}
            </div>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function StatCards() {
  const [stats, setStats] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetch24h = async () => {
      try {
        const res = await fetch('/api/stats?hours=24')
        if (res.ok) {
          setStats(await res.json())
          setLoading(false)
        }
      } catch { /* ignore */ }
    }

    fetch24h()
    const interval = setInterval(fetch24h, 30000)
    return () => clearInterval(interval)
  }, [])

  const now = new Date()
  const zurichHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Zurich', hour: 'numeric', hour12: false }).format(now)
  )
  const isNight = zurichHour < 6 || zurichHour >= 22
  const leqExt = isNight ? stats?.night_leq_ext : stats?.day_leq_ext
  const leqInt = isNight ? stats?.night_leq_int : stats?.day_leq_int
  const limit = isNight ? NOISE_LIMITS.night : NOISE_LIMITS.day

  const worstLine = stats?.by_line?.[0]

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        title={`24h Leq Exterior (${isNight ? 'night' : 'day'})`}
        value={loading ? null : leqExt != null ? leqExt.toFixed(1) : '—'}
        unit="dB(A)"
        sub={leqExt != null ? `ES II limit: ${limit} dB${leqExt > limit ? ` (+${(leqExt - limit).toFixed(1)} dB over)` : ' ✓'}` : undefined}
        icon={Wind}
        color={leqExt != null ? dbColor(leqExt, limit) : undefined}
      />
      <StatCard
        title="24h Leq Interior"
        value={loading ? null : leqInt != null ? leqInt.toFixed(1) : '—'}
        unit="dB(A)"
        sub={leqInt != null ? `${isNight ? 'Night' : 'Day'} level` : undefined}
        icon={TrendingDown}
        color="#60A5FA"
      />
      <StatCard
        title="Mean Attenuation"
        value={loading ? null : stats?.attenuation_mean_db != null ? stats.attenuation_mean_db.toFixed(1) : '—'}
        unit="dB"
        sub="Exterior − Interior"
        icon={TrendingDown}
        color="hsl(213 31% 91%)"
      />
      <StatCard
        title="Tram Events Today"
        value={loading ? null : String(stats?.tram_events_count ?? 0)}
        sub={worstLine ? `Line ${worstLine.line} → ${worstLine.headsign} (${worstLine.count}×)` : undefined}
        icon={Train}
        color="#F59E0B"
      />
    </div>
  )
}
