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
import { Search, RefreshCw, CheckCircle2, AlertCircle, Save, MapPin, ChevronDown, ChevronUp, Smartphone, Trash2 } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { BrowserMicCard } from '@/components/settings/browser-mic'
import { useRecorder } from '@/lib/recorder-context'

interface LineDetail {
  line: string
  category: string   // 't', 'b', etc.
  directions: string[]
}

interface Platform {
  stop_id: string
  stop_name: string
  line: string
  lines_detail?: LineDetail[]
  direction_id: number | null
  headsign: string | null
  platform: string | null
  active: boolean
  monitored_lines?: string | null
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
  // ── This-device identity (localStorage) ─────────────────────────────────────
  const { micSource, setMicSource, deviceLabel, setDeviceLabel } = useRecorder()

  const [deviceId, setDeviceId] = useState('')
  useEffect(() => {
    let id = localStorage.getItem('tramwatchDeviceId')
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
      localStorage.setItem('tramwatchDeviceId', id)
    }
    setDeviceId(id)
  }, [])

  // ── Active / monitored state ────────────────────────────────────────────────
  const [monitoredStop, setMonitoredStop] = useState<string | null>(null)
  const [activeGroups, setActiveGroups] = useState<StopResult[]>([])
  const [activePlatformCount, setActivePlatformCount] = useState(0)

  // ── Search / configure state ────────────────────────────────────────────────
  const [configuring, setConfiguring] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<StopResult[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [selectedStops, setSelectedStops] = useState<Set<string>>(new Set())
  const [lineSelections, setLineSelections] = useState<Map<string, Set<string>>>(new Map())
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
      // Populate lineSelections from monitored_lines
      const newLineSelections = new Map<string, Set<string>>()
      for (const group of (data.stops as StopResult[])) {
        for (const p of group.platforms) {
          if (p.monitored_lines && p.monitored_lines.trim().length > 0) {
            const lines = p.monitored_lines.split(',').map((l: string) => l.trim()).filter(Boolean)
            if (lines.length > 0) {
              newLineSelections.set(p.stop_id, new Set(lines))
            }
          }
        }
      }
      setLineSelections(newLineSelections)
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
    setSearchError(null)
    setSearched(false)
    try {
      const res = await fetch(`/api/stops/search?q=${encodeURIComponent(query)}`)
      const data = await res.json()
      if (!res.ok) {
        setSearchError(data.error ?? `Search failed (${res.status})`)
        setSearchResults([])
      } else {
        const results = data.results as StopResult[]
        setSearchResults(results)
        // Auto-populate lineSelections with tram lines (category starts with 't')
        const newLineSelections = new Map<string, Set<string>>()
        for (const group of results) {
          for (const p of group.platforms) {
            const tramLines = (p.lines_detail ?? [])
              .filter(ld => ld.category.toLowerCase().startsWith('t'))
              .map(ld => ld.line)
            if (tramLines.length > 0) {
              newLineSelections.set(p.stop_id, new Set(tramLines))
            }
          }
        }
        setLineSelections(newLineSelections)
        // selectedStops = all stop_ids that appear in lineSelections
        setSelectedStops(new Set(newLineSelections.keys()))
      }
    } catch {
      setSearchError('Network error — could not reach search API')
      setSearchResults([])
    } finally {
      setSearching(false)
      setSearched(true)
    }
  }

  // ── Toggle line selection ─────────────────────────────────────────────────
  const toggleLine = (stopId: string, line: string) => {
    setLineSelections(prev => {
      const next = new Map(prev)
      const lines = new Set(next.get(stopId) ?? [])
      if (lines.has(line)) {
        lines.delete(line)
      } else {
        lines.add(line)
      }
      if (lines.size === 0) {
        next.delete(stopId)
      } else {
        next.set(stopId, lines)
      }
      // Keep selectedStops in sync
      setSelectedStops(new Set(next.keys()))
      return next
    })
  }

  // ── Save configuration ────────────────────────────────────────────────────
  const saveStops = async () => {
    setSavingStops(true)
    try {
      // Only save stop_ids that have at least one line selected
      const stops = Array.from(lineSelections.keys())
      const allPlatforms = displayResults.flatMap(g => g.platforms)
      const stopData = allPlatforms.filter(p => lineSelections.has(p.stop_id))

      const res = await fetch('/api/stops/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stops,
          stop_data: stopData.map(p => ({
            stop_id:        p.stop_id,
            stop_name:      p.stop_name,
            line:           p.line,
            headsign:       p.headsign,
            monitored_lines: Array.from(lineSelections.get(p.stop_id) ?? []).sort().join(',') || null,
          })),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        const totalLines = Array.from(lineSelections.values()).reduce((n, s) => n + s.size, 0)
        toast({ title: 'Configuration saved', description: `${totalLines} line(s) across ${stops.length} stop(s) active` })
        await fetchActiveStops()
        setSearchResults([])
        setConfiguring(false)
      } else {
        toast({
          title: 'Save failed',
          description: data.detail ?? data.error ?? `HTTP ${res.status}`,
          variant: 'destructive',
        })
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

  // Count total lines across all lineSelections entries
  const totalLinesSelected = Array.from(lineSelections.values()).reduce((n, s) => n + s.size, 0)
  const totalStopsSelected = lineSelections.size

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Settings</h1>

      {/* ── This Device ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-muted-foreground" />
            This Device
          </CardTitle>
          <CardDescription>
            Role and label for this browser / device. Each device that records mic data
            should have its own role and a recognisable name.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Source name */}
          <div className="space-y-1.5">
            <label htmlFor="device-source" className="text-sm font-medium text-foreground">
              Source name
            </label>
            <Input
              id="device-source"
              value={micSource}
              onChange={e => {
                const v = e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
                setMicSource(v || 'default')
              }}
              placeholder="e.g. roof, iphone, laptop"
              className="max-w-xs font-mono"
            />
            <p className="text-xs text-muted-foreground">
              A short name identifying where this device is placed. Each unique name appears as its own line on the live chart.
            </p>
          </div>

          {/* Label */}
          <div className="space-y-1.5">
            <label htmlFor="device-label" className="text-sm font-medium text-foreground">
              Device label
            </label>
            <Input
              id="device-label"
              value={deviceLabel}
              onChange={e => setDeviceLabel(e.target.value)}
              placeholder="e.g. iPhone 15, MacBook, Raspberry Pi"
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              Stored with every reading so you can filter by device in future views.
            </p>
          </div>

          {/* Device ID (informational) */}
          {deviceId && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Device ID (auto-generated, stable per browser)</p>
              <p className="text-[11px] font-mono text-muted-foreground/60 break-all">{deviceId}</p>
            </div>
          )}
        </CardContent>
      </Card>

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
                if (!configuring) {
                  setSearchResults([])
                  setSearchError(null)
                  setSearched(false)
                }
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
                  <p className="text-sm font-medium text-foreground">{group.stop_name}</p>
                  <div className="space-y-1 pl-3 mt-1">
                    {group.platforms.map(p => {
                      const ml = p.monitored_lines?.trim()
                      const lineList = ml
                        ? ml.split(',').map(l => l.trim()).filter(Boolean).join(', ')
                        : p.line || 'all lines'
                      return (
                        <p key={p.stop_id} className="text-xs text-muted-foreground">
                          Monitoring: Lines {lineList}
                        </p>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        )}

        {!configuring && !monitoredStop && (
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground">
              Click <strong>Configure</strong> to search for your tram stop and select lines to monitor.
            </p>
          </CardContent>
        )}

        {/* Search + line selection */}
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
              <div className="space-y-4">
                {displayResults.map(group => {
                  // Collect all lines_detail across platforms for this stop name
                  // Group by category: trams first, buses, other
                  const platformsWithDetail = group.platforms.filter(p => p.lines_detail && p.lines_detail.length > 0)

                  return (
                    <div key={`${group.stop_name}-${group.line}`} className="space-y-2">
                      <span className="text-sm font-medium text-foreground">{group.stop_name}</span>

                      {platformsWithDetail.map(p => {
                        const trams = (p.lines_detail ?? []).filter(ld => ld.category.toLowerCase().startsWith('t'))
                        const buses = (p.lines_detail ?? []).filter(ld => ld.category.toLowerCase().startsWith('b'))
                        const other = (p.lines_detail ?? []).filter(ld =>
                          !ld.category.toLowerCase().startsWith('t') &&
                          !ld.category.toLowerCase().startsWith('b')
                        )

                        const categoryGroups: Array<{ label: string; lines: LineDetail[] }> = []
                        if (trams.length > 0) categoryGroups.push({ label: 'Trams', lines: trams })
                        if (buses.length > 0) categoryGroups.push({ label: 'Buses', lines: buses })
                        if (other.length > 0) categoryGroups.push({ label: 'Other', lines: other })

                        if (categoryGroups.length === 0) return null

                        return (
                          <div key={p.stop_id} className="pl-3 space-y-2">
                            {categoryGroups.map(({ label, lines }) => (
                              <div key={label}>
                                <p className="text-xs text-muted-foreground mb-1">{label}</p>
                                <div className="space-y-1 pl-2">
                                  {lines.map(ld => {
                                    const checked = lineSelections.get(p.stop_id)?.has(ld.line) ?? false
                                    return (
                                      <div key={ld.line} className="flex items-center gap-3">
                                        <Checkbox
                                          id={`${p.stop_id}-${ld.line}`}
                                          checked={checked}
                                          onCheckedChange={() => toggleLine(p.stop_id, ld.line)}
                                        />
                                        <label
                                          htmlFor={`${p.stop_id}-${ld.line}`}
                                          className="text-sm cursor-pointer flex items-center gap-2"
                                        >
                                          <Badge variant="outline" className="text-xs font-mono px-1.5 py-0">
                                            {ld.line}
                                          </Badge>
                                          <span className="text-muted-foreground text-xs">
                                            {ld.directions.slice(0, 3).join(' / ')}
                                          </span>
                                        </label>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}

                <p className="text-xs text-muted-foreground">
                  {totalLinesSelected} line{totalLinesSelected !== 1 ? 's' : ''} selected across {totalStopsSelected} stop{totalStopsSelected !== 1 ? 's' : ''}
                </p>
                <Button
                  onClick={saveStops}
                  disabled={savingStops || totalLinesSelected === 0}
                  size="sm"
                >
                  <Save className="h-4 w-4 mr-2" />
                  {savingStops ? 'Saving…' : 'Save as monitoring location'}
                </Button>
              </div>
            )}

            {searchError && (
              <p className="text-xs text-destructive">{searchError}</p>
            )}
            {!searchError && searched && displayResults.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No stops found for &ldquo;{query}&rdquo;. Try a shorter name.
              </p>
            )}
            {!searched && !searchError && (
              <p className="text-xs text-muted-foreground">
                Type a stop name and press Enter or Search.
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

      {/* ── Browser Microphone ──────────────────────────────────────────────── */}
      <BrowserMicCard />

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

      {/* ── Danger Zone ─────────────────────────────────────────────────────── */}
      <DangerZoneCard />
    </div>
  )
}

function DangerZoneCard() {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'clearing' | 'done'>('idle')
  const [deleted, setDeleted] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const clear = async () => {
    setPhase('clearing')
    setErr(null)
    try {
      const res = await fetch('/api/admin/clear-readings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'yes' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Unknown error')
      setDeleted(data.deleted ?? null)
      setPhase('done')
    } catch (e) {
      setErr(String(e))
      setPhase('idle')
    }
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 text-destructive">
          <Trash2 className="h-4 w-4" />
          Danger Zone
        </CardTitle>
        <CardDescription>Irreversible actions — use with care.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {phase === 'done' ? (
          <p className="text-sm text-green-400">
            All readings deleted{deleted !== null ? ` (${deleted} rows)` : ''}. Database is now empty.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Delete <strong>all readings</strong> from the database and start a clean recording session.
            </p>
            {err && <p className="text-sm text-destructive">{err}</p>}
            {phase === 'idle' && (
              <Button size="sm" variant="destructive" onClick={() => setPhase('confirm')}>
                <Trash2 className="h-4 w-4 mr-2" />
                Clear all readings
              </Button>
            )}
            {phase === 'confirm' && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-destructive font-medium">Are you sure? This cannot be undone.</span>
                <Button size="sm" variant="destructive" onClick={clear}>Yes, delete everything</Button>
                <Button size="sm" variant="ghost" onClick={() => setPhase('idle')}>Cancel</Button>
              </div>
            )}
            {phase === 'clearing' && (
              <Button size="sm" variant="destructive" disabled>
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                Clearing…
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
