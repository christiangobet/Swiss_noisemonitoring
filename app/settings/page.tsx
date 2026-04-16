'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { NOISE_LIMITS } from '@/lib/db'
import { formatZurichTime } from '@/lib/utils'
import { Search, RefreshCw, CheckCircle2, AlertCircle, Save } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

interface StopResult {
  stop_name: string
  line: string
  platforms: Array<{
    stop_id: string
    stop_name: string
    line: string
    direction_id: number | null
    headsign: string | null
    platform: string | null
    active: boolean
  }>
}

interface GtfsMeta {
  fetched_at: string
  feed_version: string | null
  valid_from: string | null
  valid_to: string | null
}

interface SensorStatus {
  online: boolean
  last_seen: string | null
}

export default function SettingsPage() {
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<StopResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedStops, setSelectedStops] = useState<Set<string>>(new Set())
  const [activeStops, setActiveStops] = useState<StopResult[]>([])
  const [savingStops, setSavingStops] = useState(false)

  const [gtfsMeta, setGtfsMeta] = useState<GtfsMeta | null>(null)
  const [gtfsLoading, setGtfsLoading] = useState(false)
  const [gtfsRefreshing, setGtfsRefreshing] = useState(false)

  const [sensors, setSensors] = useState<{
    exterior: SensorStatus & { count_today: number; mean_db_today: number | null }
    interior: SensorStatus & { count_today: number; mean_db_today: number | null }
  } | null>(null)

  const fetchGtfsMeta = useCallback(async () => {
    setGtfsLoading(true)
    try {
      // We'll infer from /api/calibration which also returns sensor state
      const calibRes = await fetch('/api/calibration')
      if (calibRes.ok) {
        const data = await calibRes.json()
        setSensors({
          exterior: { ...data.sensors.exterior, count_today: 0, mean_db_today: null },
          interior: { ...data.sensors.interior, count_today: 0, mean_db_today: null },
        })
      }
    } catch { /* ignore */ } finally {
      setGtfsLoading(false)
    }
  }, [])

  const fetchActiveStops = useCallback(async () => {
    try {
      const res = await fetch('/api/stops/search?q=a')
      if (res.ok) {
        const data = await res.json()
        const active = (data.results as StopResult[]).filter(r =>
          r.platforms.some(p => p.active)
        )
        setActiveStops(active)
        const activePlatformIds = new Set(
          active.flatMap(r => r.platforms.filter(p => p.active).map(p => p.stop_id))
        )
        setSelectedStops(activePlatformIds)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchGtfsMeta()
    fetchActiveStops()
  }, [fetchGtfsMeta, fetchActiveStops])

  const handleSearch = async () => {
    if (query.trim().length < 2) return
    setSearching(true)
    try {
      const res = await fetch(`/api/stops/search?q=${encodeURIComponent(query)}`)
      if (res.ok) {
        const data = await res.json()
        setSearchResults(data.results)
      }
    } catch { /* ignore */ } finally {
      setSearching(false)
    }
  }

  const toggleStop = (stopId: string) => {
    setSelectedStops(prev => {
      const next = new Set(prev)
      if (next.has(stopId)) next.delete(stopId)
      else next.add(stopId)
      return next
    })
  }

  const saveStops = async () => {
    setSavingStops(true)
    try {
      const res = await fetch('/api/stops/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stops: Array.from(selectedStops) }),
      })
      if (res.ok) {
        toast({ title: 'Stops saved', description: `${selectedStops.size} stop(s) active` })
        fetchActiveStops()
      } else {
        toast({ title: 'Error', description: 'Failed to save stops', variant: 'destructive' })
      }
    } catch { /* ignore */ } finally {
      setSavingStops(false)
    }
  }

  const refreshGtfs = async () => {
    setGtfsRefreshing(true)
    try {
      const res = await fetch('/api/gtfs/refresh', {
        method: 'POST',
        headers: { 'x-api-key': '' }, // user provides key in Vercel env; this is a manual trigger hint
      })
      const data = await res.json()
      if (res.ok) {
        toast({ title: 'GTFS refreshed', description: `${data.stops_updated} stops updated` })
        fetchGtfsMeta()
      } else {
        toast({ title: 'GTFS refresh failed', description: data.error, variant: 'destructive' })
      }
    } catch { /* ignore */ } finally {
      setGtfsRefreshing(false)
    }
  }

  const resultsToShow = searchResults.length > 0 ? searchResults : activeStops

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Settings</h1>

      {/* Stop configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tram Stop Configuration</CardTitle>
          <CardDescription>
            Search for stops near Römerhofplatz and select which platforms to monitor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Search stop name, e.g. Römerhofplatz"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="flex-1"
            />
            <Button onClick={handleSearch} disabled={searching} size="sm">
              {searching ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>

          {resultsToShow.length > 0 && (
            <div className="space-y-3">
              {resultsToShow.map(group => (
                <div key={`${group.stop_name}-${group.line}`} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{group.stop_name}</span>
                    <Badge variant="outline">Line {group.line}</Badge>
                  </div>
                  {group.platforms.map(p => (
                    <div key={p.stop_id} className="flex items-center gap-3 pl-4">
                      <Checkbox
                        id={p.stop_id}
                        checked={selectedStops.has(p.stop_id)}
                        onCheckedChange={() => toggleStop(p.stop_id)}
                      />
                      <label htmlFor={p.stop_id} className="text-sm text-muted-foreground cursor-pointer flex-1">
                        <span className="text-foreground">{p.headsign ?? 'Direction unknown'}</span>
                        {p.platform && <span className="ml-2 text-xs">({p.platform})</span>}
                        <span className="ml-2 font-mono text-xs opacity-50">{p.stop_id}</span>
                      </label>
                    </div>
                  ))}
                </div>
              ))}
              <Button onClick={saveStops} disabled={savingStops} size="sm">
                <Save className="h-4 w-4 mr-2" />
                {savingStops ? 'Saving…' : `Save ${selectedStops.size} stop(s)`}
              </Button>
            </div>
          )}
          {resultsToShow.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Search for a stop name to configure monitoring.
            </p>
          )}
        </CardContent>
      </Card>

      {/* GTFS status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GTFS Data</CardTitle>
          <CardDescription>VBZ Zürich tram schedule data (weekly auto-refresh Mondays 03:00 UTC)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {gtfsLoading ? <Skeleton className="h-16 w-full" /> : (
            <div className="text-sm space-y-1">
              {gtfsMeta ? (
                <>
                  <p className="text-muted-foreground">
                    Last refresh: <span className="text-foreground">{formatZurichTime(gtfsMeta.fetched_at, 'datetime')}</span>
                  </p>
                  {gtfsMeta.valid_from && gtfsMeta.valid_to && (
                    <p className="text-muted-foreground">
                      Valid: <span className="text-foreground">{gtfsMeta.valid_from} → {gtfsMeta.valid_to}</span>
                    </p>
                  )}
                  {gtfsMeta.feed_version && (
                    <p className="text-muted-foreground">Version: <span className="text-foreground">{gtfsMeta.feed_version}</span></p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">No GTFS data loaded yet.</p>
              )}
            </div>
          )}
          <Button size="sm" variant="outline" onClick={refreshGtfs} disabled={gtfsRefreshing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${gtfsRefreshing ? 'animate-spin' : ''}`} />
            {gtfsRefreshing ? 'Refreshing…' : 'Refresh GTFS Now'}
          </Button>
        </CardContent>
      </Card>

      {/* Sensor status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sensor Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {(['exterior', 'interior'] as const).map(src => {
              const sensor = sensors?.[src]
              const online = sensor?.online ?? false
              return (
                <div key={src} className="space-y-1">
                  <div className="flex items-center gap-2">
                    {online
                      ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                      : <AlertCircle className="h-4 w-4 text-red-500" />}
                    <span className="text-sm font-medium text-foreground capitalize">{src}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {sensor?.last_seen
                      ? `Last seen: ${formatZurichTime(sensor.last_seen, 'time')}`
                      : 'Never seen'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {src === 'exterior' ? 'Benetech GM1356 (USB SPL)' : 'USB Microphone (PyAudio)'}
                  </p>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* ES II limits (read-only) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Swiss LSV Noise Limits (ES II Residential)</CardTitle>
          <CardDescription>Read-only display of active thresholds</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="space-y-1">
              <p className="text-muted-foreground">Day (06:00–22:00)</p>
              <p className="font-db text-xl font-bold text-foreground">{NOISE_LIMITS.day} dB(A)</p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">Night (22:00–06:00)</p>
              <p className="font-db text-xl font-bold text-foreground">{NOISE_LIMITS.night} dB(A)</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
