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
import { Search, RefreshCw, CheckCircle2, AlertCircle, Save, MapPin, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from '@/hooks/use-toast'

interface Platform {
  stop_id: string
  stop_name: string
  line: string
  direction_id: number | null
  headsign: string | null
  platform: string | null
  active: boolean
}

interface StopResult {
  stop_name: string
  line: string
  platforms: Platform[]
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
  // ── Active / monitored state ────────────────────────────────────────────────
  const [monitoredStop, setMonitoredStop] = useState<string | null>(null)
  const [activeGroups, setActiveGroups] = useState<StopResult[]>([])
  const [activePlatformCount, setActivePlatformCount] = useState(0)

  // ── Search / configure state ────────────────────────────────────────────────
  const [configuring, setConfiguring] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<StopResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedStops, setSelectedStops] = useState<Set<string>>(new Set())
  const [savingStops, setSavingStops] = useState(false)

  // ── GTFS / sensors ──────────────────────────────────────────────────────────
  const [gtfsMeta, setGtfsMeta] = useState<GtfsMeta | null>(null)
  const [gtfsLoading, setGtfsLoading] = useState(false)
  const [gtfsRefreshing, setGtfsRefreshing] = useState(false)
  const [sensors, setSensors] = useState<{
    exterior: SensorStatus & { count_today: number; mean_db_today: number | null }
    interior: SensorStatus & { count_today: number; mean_db_today: number | null }
  } | null>(null)

  // ── Fetch active stop configuration ─────────────────────────────────────────
  const fetchActiveStops = useCallback(async () => {
    try {
      const res = await fetch('/api/stops/active')
      if (!res.ok) return
      const data = await res.json()
      setMonitoredStop(data.monitored_stop ?? null)
      setActiveGroups(data.stops ?? [])
      setActivePlatformCount(data.count ?? 0)
      // Seed selected checkboxes with currently active platform IDs
      const activePlatformIds = new Set<string>(
        (data.stops as StopResult[]).flatMap(g => g.platforms.map(p => p.stop_id))
      )
      setSelectedStops(activePlatformIds)
    } catch { /* ignore */ }
  }, [])

  // ── Fetch GTFS meta + sensor state ──────────────────────────────────────────
  const fetchMeta = useCallback(async () => {
    setGtfsLoading(true)
    try {
      const [metaRes, calibRes] = await Promise.all([
        fetch('/api/gtfs/meta'),
        fetch('/api/calibration'),
      ])
      if (metaRes.ok) {
        const data = await metaRes.json()
        setGtfsMeta(data.meta ?? null)
      }
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

  useEffect(() => {
    fetchActiveStops()
    fetchMeta()
  }, [fetchActiveStops, fetchMeta])

  // ── Search ───────────────────────────────────────────────────────────────────
  const handleSearch = async () => {
    if (query.trim().length < 2) return
    setSearching(true)
    try {
      const res = await fetch(`/api/stops/search?q=${encodeURIComponent(query)}`)
      if (res.ok) {
        const data = await res.json()
        const results = data.results as StopResult[]
        setSearchResults(results)
        // Pre-select platforms that are already active
        const activePlatformIds = new Set<string>(
          activeGroups.flatMap(g => g.platforms.map(p => p.stop_id))
        )
        // Also pre-select all platforms from the first matching stop for convenience
        const allFromResults = new Set<string>(activePlatformIds)
        results.forEach(g => g.platforms.forEach(p => {
          if (activePlatformIds.has(p.stop_id)) allFromResults.add(p.stop_id)
        }))
        setSelectedStops(allFromResults)
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

  // ── Save configuration ────────────────────────────────────────────────────
  const saveStops = async () => {
    setSavingStops(true)
    try {
      const res = await fetch('/api/stops/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stops: Array.from(selectedStops) }),
      })
      if (res.ok) {
        toast({ title: 'Platforms saved', description: `${selectedStops.size} platform(s) active` })
        await fetchActiveStops()
        setSearchResults([])
        setConfiguring(false)
      } else {
        toast({ title: 'Error', description: 'Failed to save', variant: 'destructive' })
      }
    } catch { /* ignore */ } finally {
      setSavingStops(false)
    }
  }

  // ── GTFS refresh ─────────────────────────────────────────────────────────────
  // When a stop is already configured, pass its name so the refresh only processes
  // platforms for that stop (skips ~99% of stop_times.txt rows → much faster).
  const refreshGtfs = async () => {
    setGtfsRefreshing(true)
    const url = monitoredStop
      ? `/api/gtfs/refresh?q=${encodeURIComponent(monitoredStop)}`
      : '/api/gtfs/refresh'
    try {
      const res = await fetch(url)
      const data = await res.json()
      if (res.ok) {
        toast({
          title: 'GTFS refreshed',
          description: `${data.tram_stops_upserted} platform(s) updated` +
            (data.stop_filter ? ` for "${data.stop_filter}"` : ''),
        })
        setGtfsMeta({
          fetched_at:   new Date().toISOString(),
          feed_version: data.feed_version ?? null,
          valid_from:   data.valid_from ?? null,
          valid_to:     data.valid_to   ?? null,
        })
        // Re-fetch active stops in case platforms changed
        fetchActiveStops()
      } else {
        toast({ title: 'GTFS refresh failed', description: data.error, variant: 'destructive' })
      }
    } catch { /* ignore */ } finally {
      setGtfsRefreshing(false)
    }
  }

  const displayResults = searchResults.length > 0 ? searchResults : []

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Settings</h1>

      {/* ── Monitoring Location ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                Monitoring Location
              </CardTitle>
              {monitoredStop ? (
                <CardDescription className="mt-1">
                  {activePlatformCount} platform{activePlatformCount !== 1 ? 's' : ''} active
                </CardDescription>
              ) : (
                <CardDescription className="mt-1">No location configured</CardDescription>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfiguring(v => !v)
                if (!configuring) setSearchResults([])
              }}
            >
              {configuring ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {configuring ? 'Cancel' : (monitoredStop ? 'Change' : 'Configure')}
            </Button>
          </div>
        </CardHeader>

        {/* Active platforms summary */}
        {!configuring && monitoredStop && (
          <CardContent className="pt-0">
            <div className="space-y-2">
              {activeGroups.map(group => (
                <div key={`${group.stop_name}-${group.line}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-foreground">{group.stop_name}</span>
                    <Badge variant="outline" className="text-xs">Line {group.line}</Badge>
                  </div>
                  <div className="space-y-1 pl-3">
                    {group.platforms.map(p => (
                      <p key={p.stop_id} className="text-xs text-muted-foreground">
                        → {p.headsign ?? 'Unknown direction'}
                        {p.platform && <span className="ml-1 opacity-60">({p.platform})</span>}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        )}

        {!configuring && !monitoredStop && (
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground">
              Click <strong>Configure</strong> to search for your tram stop and select platforms to monitor.
            </p>
          </CardContent>
        )}

        {/* Search + platform selection */}
        {configuring && (
          <CardContent className="pt-0 space-y-4 border-t">
            <div className="flex gap-2 pt-3">
              <Input
                placeholder="Stop name, e.g. Römerhofplatz"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                className="flex-1"
                autoFocus
              />
              <Button onClick={handleSearch} disabled={searching} size="sm">
                {searching
                  ? <RefreshCw className="h-4 w-4 animate-spin" />
                  : <Search className="h-4 w-4" />}
              </Button>
            </div>

            {displayResults.length > 0 && (
              <div className="space-y-3">
                {displayResults.map(group => (
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
                        <label htmlFor={p.stop_id} className="text-sm cursor-pointer flex-1">
                          <span className="text-foreground">{p.headsign ?? 'Direction unknown'}</span>
                          {p.platform && <span className="ml-2 text-xs text-muted-foreground">({p.platform})</span>}
                          <span className="ml-2 font-mono text-xs opacity-40">{p.stop_id}</span>
                        </label>
                      </div>
                    ))}
                  </div>
                ))}

                <p className="text-xs text-muted-foreground">
                  {selectedStops.size} platform{selectedStops.size !== 1 ? 's' : ''} selected
                </p>
                <Button
                  onClick={saveStops}
                  disabled={savingStops || selectedStops.size === 0}
                  size="sm"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {savingStops ? 'Saving…' : 'Save as monitoring location'}
                </Button>
              </div>
            )}

            {displayResults.length === 0 && query.length < 2 && (
              <p className="text-xs text-muted-foreground">
                Type at least 2 characters and press Enter or click Search.
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ── GTFS Data ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GTFS Schedule Data</CardTitle>
          <CardDescription>
            {monitoredStop
              ? `VBZ feed — only platforms for "${monitoredStop}" are loaded`
              : 'VBZ Zürich tram schedule data'}
            {' '}· weekly auto-refresh Mon 03:00 UTC
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {gtfsLoading ? <Skeleton className="h-14 w-full" /> : (
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
                    <p className="text-muted-foreground">
                      Version: <span className="text-foreground">{gtfsMeta.feed_version}</span>
                    </p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">No GTFS data loaded yet.</p>
              )}
            </div>
          )}
          <Button size="sm" variant="outline" onClick={refreshGtfs} disabled={gtfsRefreshing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${gtfsRefreshing ? 'animate-spin' : ''}`} />
            {gtfsRefreshing
              ? 'Refreshing…'
              : monitoredStop
                ? `Refresh for "${monitoredStop}"`
                : 'Refresh GTFS (full)'}
          </Button>
        </CardContent>
      </Card>

      {/* ── Sensor Status ────────────────────────────────────────────────────── */}
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

      {/* ── Swiss LSV Noise Limits ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Swiss LSV Noise Limits (ES II Residential)</CardTitle>
          <CardDescription>Read-only display of active thresholds</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="space-y-1">
              <p className="text-muted-foreground">Day (06:00–22:00)</p>
              <p className="font-mono text-xl font-bold text-foreground">{NOISE_LIMITS.day} dB(A)</p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">Night (22:00–06:00)</p>
              <p className="font-mono text-xl font-bold text-foreground">{NOISE_LIMITS.night} dB(A)</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
