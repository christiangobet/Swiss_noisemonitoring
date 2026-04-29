# Correlation View Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the whole app with a PIN, add `/analysis` page with a noise overlay chart and per-line/direction tram marker offset calibration.

**Architecture:** `iron-session` v8 handles cookie-based PIN auth — middleware reads the encrypted session cookie on every request. New `tram_line_offsets` DB table stores per-line×direction second offsets (±60s) so tram schedule markers on the chart can be visually aligned with actual noise peaks. The analysis page fetches hourly noise from the existing `/api/history` endpoint and tram-flagged events from a new `/api/analysis/tram-events` endpoint; markers are only shown for ranges ≤ 48 h.

**Tech Stack:** Next.js 14 App Router, `iron-session` v8, Recharts (`ComposedChart`), shadcn/ui, Neon Postgres (`@neondatabase/serverless`)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/session.ts` | Create | `SessionData` type + `sessionOptions` (shared by middleware + auth routes) |
| `middleware.ts` | Create | Reads session cookie via `unsealData`, redirects to `/login` if missing/invalid |
| `app/login/page.tsx` | Create | PIN entry form — POSTs to `/api/auth/login`, redirects to `/` on success |
| `app/api/auth/login/route.ts` | Create | Validates `APP_PIN`, writes session cookie via `getIronSession` |
| `app/api/auth/logout/route.ts` | Create | Destroys session cookie, redirects to `/login` |
| `app/analysis/page.tsx` | Create | Analysis page — time range selector, chart, offset panel |
| `app/api/tram-offsets/route.ts` | Create | GET all offsets / POST upsert one offset |
| `app/api/analysis/tram-events/route.ts` | Create | GET tram-flagged readings for a time range |
| `components/analysis/correlation-chart.tsx` | Create | Recharts overlay: noise lines + vertical tram markers shifted by offsets |
| `components/analysis/tram-offset-panel.tsx` | Create | Sliders per line×direction, real-time chart update, Save button |
| `lib/db.ts` | Modify | Add `tram_line_offsets` SQL to `MIGRATION_SQL` + `TramLineOffset` interface |
| `components/layout/sidebar.tsx` | Modify | Add Analysis nav item (BarChart2) + Logout button |

---

## Tasks

### Task 1: Install iron-session

**Files:** `package.json`

- [ ] Install the package:
```bash
npm install iron-session
```
Expected: `iron-session` in `package.json` dependencies.

- [ ] Verify TypeScript is happy:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```
Expected: no new errors (package ships its own types).

- [ ] Commit:
```bash
git add package.json package-lock.json
git commit -m "deps: add iron-session for cookie-based PIN auth"
```

---

### Task 2: DB schema — tram_line_offsets

**Files:** `lib/db.ts`

- [ ] Append to `MIGRATION_SQL` in `lib/db.ts`, inside the template literal before the closing backtick:

```sql
CREATE TABLE IF NOT EXISTS tram_line_offsets (
  id          SERIAL PRIMARY KEY,
  line        TEXT NOT NULL,
  direction   TEXT NOT NULL,
  offset_sec  INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line, direction)
);
```

- [ ] Add this interface after the existing exported interfaces in `lib/db.ts`:

```ts
export interface TramLineOffset {
  id: number
  line: string
  direction: string
  offset_sec: number
  updated_at: string
}
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Commit:
```bash
git add lib/db.ts
git commit -m "feat: add tram_line_offsets schema and TramLineOffset type"
```

---

### Task 3: Session helper

**Files:** Create `lib/session.ts`

- [ ] Create `lib/session.ts`:

```ts
import { SessionOptions } from 'iron-session'

export interface SessionData {
  authenticated?: boolean
}

// password must be ≥ 32 chars. In production set SESSION_SECRET env var.
export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? 'dev-placeholder-must-be-32-chars-min!!',
  cookieName: 'tramwatch-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  },
}
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Commit:
```bash
git add lib/session.ts
git commit -m "feat: add iron-session SessionData type and options"
```

---

### Task 4: Auth API routes

**Files:** Create `app/api/auth/login/route.ts`, `app/api/auth/logout/route.ts`

- [ ] Create `app/api/auth/login/route.ts`:

```ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/session'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const pin  = typeof body.pin === 'string' ? body.pin : ''

  if (!pin || pin !== process.env.APP_PIN) {
    return NextResponse.json({ error: 'Incorrect PIN' }, { status: 401 })
  }

  const res     = NextResponse.json({ ok: true })
  const session = await getIronSession<SessionData>(req, res, sessionOptions)
  session.authenticated = true
  await session.save()
  return res
}
```

- [ ] Create `app/api/auth/logout/route.ts`:

```ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/session'

export async function POST(req: NextRequest) {
  const res     = NextResponse.redirect(new URL('/login', req.url))
  const session = await getIronSession<SessionData>(req, res, sessionOptions)
  session.destroy()
  await session.save()
  return res
}
```

- [ ] Add env vars to `.env.local` (create if absent — do **not** commit this file):
```
APP_PIN=1234
SESSION_SECRET=please-change-to-a-random-32-char-string-here!
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Start dev server (`npm run dev`) and test:
```bash
# Wrong PIN → 401
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"pin":"wrong"}' | cat
# Expected: {"error":"Incorrect PIN"}

# Correct PIN → 200 + Set-Cookie header
curl -si -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"pin":"1234"}' | grep -E 'HTTP|Set-Cookie|ok'
# Expected: HTTP/1.1 200 ... Set-Cookie: tramwatch-session=... {"ok":true}
```

- [ ] Commit:
```bash
git add app/api/auth/login/route.ts app/api/auth/logout/route.ts
git commit -m "feat: add PIN auth login/logout API routes"
```

---

### Task 5: Middleware — PIN gate

**Files:** Create `middleware.ts` at project root (alongside `next.config.js`)

- [ ] Create `middleware.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { unsealData } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/session'

const PUBLIC_PREFIXES = ['/login', '/api/auth/', '/api/ingest']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const cookieValue = request.cookies.get('tramwatch-session')?.value
  if (!cookieValue) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  try {
    const session = await unsealData<SessionData>(cookieValue, {
      password: sessionOptions.password as string,
    })
    if (!session.authenticated) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
  } catch {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Manual test — open `http://localhost:3000` in an incognito window (no cookie). Should redirect to `/login`. Opening `http://localhost:3000/api/ingest` should NOT redirect (Pi daemon path stays public).

- [ ] Commit:
```bash
git add middleware.ts
git commit -m "feat: add Next.js middleware — PIN gate on all routes"
```

---

### Task 6: Login page

**Files:** Create `app/login/page.tsx`

- [ ] Create `app/login/page.tsx`:

```tsx
'use client'

import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Radio } from 'lucide-react'

export default function LoginPage() {
  const [pin, setPin]       = useState('')
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      if (res.ok) {
        router.push('/')
        router.refresh()
      } else {
        setError('Incorrect PIN')
        setPin('')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="w-full max-w-sm mx-4">
        <CardHeader className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2">
            <Radio className="h-6 w-6 text-amber-400" />
            <span className="text-lg font-semibold">
              {process.env.NEXT_PUBLIC_APP_TITLE ?? 'TramWatch'}
            </span>
          </div>
          <CardTitle className="text-sm font-normal text-muted-foreground">
            Enter PIN to continue
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Input
              type="password"
              placeholder="••••"
              value={pin}
              onChange={e => setPin(e.target.value)}
              maxLength={8}
              autoFocus
              className="text-center text-xl tracking-[0.5em]"
            />
            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}
            <Button type="submit" disabled={loading || pin.length === 0}>
              {loading ? 'Checking…' : 'Unlock'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Manual test — open incognito, visit `http://localhost:3000`. Redirected to `/login`. Enter wrong PIN → "Incorrect PIN". Enter `1234` → redirected to `/`.

- [ ] Commit:
```bash
git add app/login/page.tsx
git commit -m "feat: add PIN login page"
```

---

### Task 7: Sidebar — Analysis nav + Logout

**Files:** Modify `components/layout/sidebar.tsx`

- [ ] Add `BarChart2` and `LogOut` to the lucide-react import:

```tsx
import {
  Activity,
  History,
  FileText,
  Settings,
  Gauge,
  Radio,
  BarChart2,
  LogOut,
} from 'lucide-react'
```

- [ ] Insert the Analysis entry into `NAV_ITEMS` between History and Reports:

```tsx
const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: Activity },
  { href: '/history', label: 'History', icon: History },
  { href: '/analysis', label: 'Analysis', icon: BarChart2 },
  { href: '/reports', label: 'Reports', icon: FileText },
  { href: '/calibration', label: 'Calibration', icon: Gauge },
  { href: '/settings', label: 'Settings', icon: Settings },
]
```

- [ ] Add a Logout button immediately before the `{/* Footer */}` comment:

```tsx
      {/* Logout */}
      <div className="px-2 pb-1">
        <form action="/api/auth/logout" method="POST">
          <button
            type="submit"
            className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            Logout
          </button>
        </form>
      </div>
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Manual test — sidebar shows "Analysis" between History and Reports. Logout button appears at the bottom. Clicking Logout redirects to `/login`.

- [ ] Commit:
```bash
git add components/layout/sidebar.tsx
git commit -m "feat: add Analysis nav item and Logout button to sidebar"
```

---

### Task 8: Tram offsets API

**Files:** Create `app/api/tram-offsets/route.ts`

- [ ] Create `app/api/tram-offsets/route.ts`:

```ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

export async function GET() {
  const rows = await sql`
    SELECT line, direction, offset_sec
    FROM tram_line_offsets
    ORDER BY line ASC, direction ASC
  `
  return NextResponse.json({ offsets: rows })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { line, direction, offset_sec } = body

  if (typeof line !== 'string' || !line.trim())
    return NextResponse.json({ error: 'Invalid line' }, { status: 400 })
  if (typeof direction !== 'string' || !direction.trim())
    return NextResponse.json({ error: 'Invalid direction' }, { status: 400 })
  if (
    typeof offset_sec !== 'number' ||
    !Number.isInteger(offset_sec) ||
    offset_sec < -60 ||
    offset_sec > 60
  )
    return NextResponse.json({ error: 'offset_sec must be integer in [-60, 60]' }, { status: 400 })

  await sql`
    INSERT INTO tram_line_offsets (line, direction, offset_sec, updated_at)
    VALUES (${line.trim()}, ${direction.trim()}, ${offset_sec}, NOW())
    ON CONFLICT (line, direction)
    DO UPDATE SET offset_sec = EXCLUDED.offset_sec, updated_at = NOW()
  `
  return NextResponse.json({ ok: true })
}
```

- [ ] Run the migration to create the new table:
```bash
curl -s http://localhost:3000/api/setup | cat
```
Expected: `{"ok":true}` and no SQL error in the server console.

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Manual test (log in via browser first to get the session cookie, then copy it from DevTools → Application → Cookies → `tramwatch-session`):
```bash
COOKIE="<paste your tramwatch-session cookie value here>"

# GET — empty initially
curl -s -H "Cookie: tramwatch-session=$COOKIE" \
  http://localhost:3000/api/tram-offsets | cat
# Expected: {"offsets":[]}

# POST — upsert one offset
curl -s -H "Cookie: tramwatch-session=$COOKIE" \
  -X POST http://localhost:3000/api/tram-offsets \
  -H 'Content-Type: application/json' \
  -d '{"line":"2","direction":"Tiefenbrunnen","offset_sec":30}' | cat
# Expected: {"ok":true}

# GET — should return the new row
curl -s -H "Cookie: tramwatch-session=$COOKIE" \
  http://localhost:3000/api/tram-offsets | cat
# Expected: {"offsets":[{"line":"2","direction":"Tiefenbrunnen","offset_sec":30}]}
```

- [ ] Commit:
```bash
git add app/api/tram-offsets/route.ts
git commit -m "feat: add tram-offsets API (GET list / POST upsert)"
```

---

### Task 9: Tram events API

**Files:** Create `app/api/analysis/tram-events/route.ts`

- [ ] Create the directory and file:
```bash
mkdir -p app/api/analysis
```

- [ ] Create `app/api/analysis/tram-events/route.ts`:

```ts
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidIso } from '@/lib/utils'

const LIMIT = 2000

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to   = searchParams.get('to')

  if (!from || !isValidIso(from)) return NextResponse.json({ error: 'Invalid from' }, { status: 400 })
  if (!to   || !isValidIso(to))   return NextResponse.json({ error: 'Invalid to' },   { status: 400 })

  const rows = await sql`
    SELECT
      ts,
      tram_line AS line,
      tram_dir  AS direction,
      db_cal
    FROM readings
    WHERE tram_flag = TRUE
      AND ts >= ${from}::timestamptz
      AND ts <= ${to}::timestamptz
      AND tram_line IS NOT NULL
    ORDER BY ts ASC
    LIMIT ${LIMIT}
  `

  return NextResponse.json({ events: rows, capped: rows.length === LIMIT })
}
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Manual test:
```bash
COOKIE="<paste your tramwatch-session cookie value here>"
curl -s -H "Cookie: tramwatch-session=$COOKIE" \
  "http://localhost:3000/api/analysis/tram-events?from=2026-04-22T00:00:00Z&to=2026-04-23T00:00:00Z" | cat
# Expected: {"events":[...], "capped":false}
# events array may be empty if no tram_flag=TRUE rows exist for that date
```

- [ ] Commit:
```bash
git add app/api/analysis/tram-events/route.ts
git commit -m "feat: add analysis/tram-events API for historical tram passages"
```

---

### Task 10: Correlation chart component

**Files:** Create `components/analysis/correlation-chart.tsx`

- [ ] Create the directory:
```bash
mkdir -p components/analysis
```

- [ ] Create `components/analysis/correlation-chart.tsx`:

```tsx
'use client'

import {
  ComposedChart, Line, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { formatZurichTime } from '@/lib/utils'

const SOURCE_COLORS = ['#F59E0B', '#60A5FA', '#34D399', '#F87171', '#A78BFA', '#FB923C']
const LINE_COLORS: Record<string, string> = { '2': '#f59e0b', '3': '#60a5fa' }
const DEFAULT_LINE_COLOR = '#a78bfa'

export interface HourPoint {
  bucket: string
  source: string
  leq: number
}

export interface TramEvent {
  ts: string
  line: string
  direction: string
}

export interface TramLineOffset {
  line: string
  direction: string
  offset_sec: number
}

interface ChartPoint {
  tsMs: number
  [source: string]: number
}

interface Props {
  hourPoints: HourPoint[]
  tramEvents: TramEvent[]
  offsets: TramLineOffset[]
  activeSourceNames: string[]
  showTramMarkers: boolean
}

export default function CorrelationChart({
  hourPoints,
  tramEvents,
  offsets,
  activeSourceNames,
  showTramMarkers,
}: Props) {
  // Build flat chart data keyed by hour bucket timestamp
  const bucketMap = new Map<number, ChartPoint>()
  for (const p of hourPoints) {
    if (!activeSourceNames.includes(p.source)) continue
    const tsMs = new Date(p.bucket).getTime()
    if (!bucketMap.has(tsMs)) bucketMap.set(tsMs, { tsMs })
    bucketMap.get(tsMs)![p.source] = p.leq
  }
  const data = Array.from(bucketMap.values()).sort((a, b) => a.tsMs - b.tsMs)

  // Offset lookup: "line|direction" → seconds
  const offsetMap = new Map<string, number>(
    offsets.map(o => [`${o.line}|${o.direction}`, o.offset_sec])
  )

  // Apply offsets to tram event timestamps
  const markers = showTramMarkers
    ? tramEvents.map(e => ({
        tsMs: new Date(e.ts).getTime() + (offsetMap.get(`${e.line}|${e.direction}`) ?? 0) * 1000,
        line: e.line,
      }))
    : []

  const xMin = data[0]?.tsMs
  const xMax = data[data.length - 1]?.tsMs

  return (
    <ResponsiveContainer width="100%" height={380}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="tsMs"
          type="number"
          scale="time"
          domain={[xMin ?? 'auto', xMax ?? 'auto']}
          tickFormatter={ms => formatZurichTime(new Date(ms).toISOString())}
          tick={{ fontSize: 11, fill: '#9ca3af' }}
          tickCount={6}
        />
        <YAxis
          domain={[30, 80]}
          tick={{ fontSize: 11, fill: '#9ca3af' }}
          label={{
            value: 'dB(A)',
            angle: -90,
            position: 'insideLeft',
            offset: 10,
            style: { fontSize: 11, fill: '#9ca3af' },
          }}
        />
        <Tooltip
          labelFormatter={ms =>
            new Date(ms as number).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })
          }
          contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 6 }}
          itemStyle={{ color: '#e5e7eb', fontSize: 12 }}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />

        {activeSourceNames.map((src, i) => (
          <Line
            key={src}
            dataKey={src}
            stroke={SOURCE_COLORS[i % SOURCE_COLORS.length]}
            dot={false}
            strokeWidth={1.5}
            connectNulls
            isAnimationActive={false}
          />
        ))}

        {markers.map((m, i) => (
          <ReferenceLine
            key={i}
            x={m.tsMs}
            stroke={LINE_COLORS[m.line] ?? DEFAULT_LINE_COLOR}
            strokeDasharray="4 4"
            strokeWidth={1}
            strokeOpacity={0.55}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Commit:
```bash
git add components/analysis/correlation-chart.tsx
git commit -m "feat: add CorrelationChart (noise lines + tram markers with offsets)"
```

---

### Task 11: Tram offset panel component

**Files:** Create `components/analysis/tram-offset-panel.tsx`

- [ ] Create `components/analysis/tram-offset-panel.tsx`:

```tsx
'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { TramLineOffset } from './correlation-chart'

const LINE_COLORS: Record<string, string> = { '2': '#f59e0b', '3': '#60a5fa' }
const DEFAULT_LINE_COLOR = '#a78bfa'

interface Props {
  knownLines: { line: string; direction: string }[]
  onOffsetsChange: (offsets: TramLineOffset[]) => void
}

export default function TramOffsetPanel({ knownLines, onOffsetsChange }: Props) {
  const [offsetMap, setOffsetMap] = useState<Record<string, number>>({})
  const [saving, setSaving]       = useState(false)
  const [savedAt, setSavedAt]     = useState<string | null>(null)

  function toArray(map: Record<string, number>): TramLineOffset[] {
    return knownLines.map(({ line, direction }) => ({
      line,
      direction,
      offset_sec: map[`${line}|${direction}`] ?? 0,
    }))
  }

  useEffect(() => {
    fetch('/api/tram-offsets')
      .then(r => r.json())
      .then(({ offsets }: { offsets: TramLineOffset[] }) => {
        const map: Record<string, number> = {}
        for (const o of offsets) map[`${o.line}|${o.direction}`] = o.offset_sec
        setOffsetMap(map)
        onOffsetsChange(toArray(map))
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleSlider(line: string, direction: string, value: number) {
    const next = { ...offsetMap, [`${line}|${direction}`]: value }
    setOffsetMap(next)
    onOffsetsChange(toArray(next))
  }

  function handleReset() {
    const next: Record<string, number> = {}
    for (const { line, direction } of knownLines) next[`${line}|${direction}`] = 0
    setOffsetMap(next)
    onOffsetsChange(toArray(next))
  }

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await Promise.all(
        knownLines.map(({ line, direction }) =>
          fetch('/api/tram-offsets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              line,
              direction,
              offset_sec: offsetMap[`${line}|${direction}`] ?? 0,
            }),
          })
        )
      )
      setSavedAt(new Date().toLocaleTimeString('de-CH'))
    } finally {
      setSaving(false)
    }
  }, [knownLines, offsetMap])

  if (knownLines.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Tram Schedule Offset</CardTitle>
        <p className="text-xs text-muted-foreground">
          Drag to align markers with noise peaks. Shifts apply to the chart immediately.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {knownLines.map(({ line, direction }) => {
          const val   = offsetMap[`${line}|${direction}`] ?? 0
          const color = LINE_COLORS[line] ?? DEFAULT_LINE_COLOR
          return (
            <div key={`${line}|${direction}`} className="grid grid-cols-[100px_1fr_48px] items-center gap-3">
              <span className="text-xs font-medium truncate" style={{ color }}>
                Line {line} · {direction}
              </span>
              <input
                type="range"
                min={-60}
                max={60}
                step={1}
                value={val}
                onChange={e => handleSlider(line, direction, Number(e.target.value))}
                style={{ accentColor: color }}
                className="w-full"
              />
              <span className="text-xs font-mono text-right text-muted-foreground">
                {val > 0 ? `+${val}s` : `${val}s`}
              </span>
            </div>
          )
        })}
        <div className="flex items-center justify-between pt-1">
          <button
            onClick={handleReset}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Reset all
          </button>
          <div className="flex items-center gap-3">
            {savedAt && (
              <span className="text-xs text-muted-foreground">Saved {savedAt}</span>
            )}
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save offsets'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Commit:
```bash
git add components/analysis/tram-offset-panel.tsx
git commit -m "feat: add TramOffsetPanel (sliders per line×direction with save)"
```

---

### Task 12: Analysis page

**Files:** Create `app/analysis/page.tsx`

- [ ] Create `app/analysis/page.tsx`:

```tsx
'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import CorrelationChart, {
  type HourPoint,
  type TramEvent,
  type TramLineOffset,
} from '@/components/analysis/correlation-chart'
import TramOffsetPanel from '@/components/analysis/tram-offset-panel'

const PRESETS = [
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d',  hours: 168 },
  { label: '30d', hours: 720 },
  { label: '3mo', hours: 2160 },
]

function toDateStr(d: Date) {
  return d.toISOString().substring(0, 10)
}

export default function AnalysisPage() {
  const now     = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000)

  const [from, setFrom]                 = useState(toDateStr(weekAgo))
  const [to, setTo]                     = useState(toDateStr(now))
  const [activePreset, setActivePreset] = useState<string | null>('7d')
  const [hourPoints, setHourPoints]     = useState<HourPoint[]>([])
  const [tramEvents, setTramEvents]     = useState<TramEvent[]>([])
  const [offsets, setOffsets]           = useState<TramLineOffset[]>([])
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)

  function applyPreset(p: typeof PRESETS[number]) {
    const toDate   = new Date()
    const fromDate = new Date(toDate.getTime() - p.hours * 3600 * 1000)
    setFrom(toDateStr(fromDate))
    setTo(toDateStr(toDate))
    setActivePreset(p.label)
  }

  const rangeHours = Math.round(
    (new Date(to + 'T23:59:59').getTime() - new Date(from + 'T00:00:00').getTime()) / 3_600_000
  )
  const showTramMarkers = rangeHours <= 48

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fromIso = new Date(from + 'T00:00:00').toISOString()
      const toIso   = new Date(to   + 'T23:59:59').toISOString()

      const histRes = await fetch(
        `/api/history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&resolution=hour`
      )
      if (!histRes.ok) throw new Error('Failed to load noise data')
      const histData = await histRes.json()
      setHourPoints(histData.points ?? [])

      if (showTramMarkers) {
        const tramRes = await fetch(
          `/api/analysis/tram-events?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
        )
        if (!tramRes.ok) throw new Error('Failed to load tram events')
        const tramData = await tramRes.json()
        setTramEvents(tramData.events ?? [])
      } else {
        setTramEvents([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [from, to, showTramMarkers])

  useEffect(() => { fetchData() }, [fetchData])

  const sourceNames = Array.from(new Set(hourPoints.map(p => p.source))).sort()
  const knownLines  = Array.from(
    new Map(
      tramEvents
        .filter(e => e.line && e.direction)
        .map(e => [`${e.line}|${e.direction}`, { line: e.line, direction: e.direction }])
    ).values()
  ).sort((a, b) => a.line.localeCompare(b.line) || a.direction.localeCompare(b.direction))

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold">Analysis</h1>

      {/* Time range selector */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex flex-col sm:flex-row flex-wrap gap-3 items-start sm:items-center">
            <div className="flex gap-1 flex-wrap">
              {PRESETS.map(p => (
                <Button
                  key={p.label}
                  size="sm"
                  variant={activePreset === p.label ? 'default' : 'outline'}
                  onClick={() => applyPreset(p)}
                  className="h-7 px-3 text-xs"
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <span className="text-muted-foreground">From</span>
              <input
                type="date"
                value={from}
                onChange={e => { setFrom(e.target.value); setActivePreset(null) }}
                className="bg-muted border border-border rounded px-2 py-1 text-sm text-foreground"
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="date"
                value={to}
                onChange={e => { setTo(e.target.value); setActivePreset(null) }}
                className="bg-muted border border-border rounded px-2 py-1 text-sm text-foreground"
              />
              <Button
                size="sm"
                onClick={fetchData}
                disabled={loading}
                className="h-7 px-3 text-xs"
              >
                {loading ? 'Loading…' : 'Load'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Chart */}
      <Card>
        <CardContent className="pt-4">
          {error && <p className="text-sm text-destructive mb-4">{error}</p>}
          {loading ? (
            <Skeleton className="h-[380px] w-full" />
          ) : hourPoints.length === 0 ? (
            <div className="h-[380px] flex items-center justify-center text-muted-foreground text-sm">
              No noise data for this range.
            </div>
          ) : (
            <CorrelationChart
              hourPoints={hourPoints}
              tramEvents={tramEvents}
              offsets={offsets}
              activeSourceNames={sourceNames}
              showTramMarkers={showTramMarkers}
            />
          )}
          {!showTramMarkers && !loading && hourPoints.length > 0 && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              Tram markers shown for ranges ≤ 48 h. Select 24h or 48h to see individual passages.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Tram offset panel — only when markers are active */}
      {showTramMarkers && (
        <TramOffsetPanel
          knownLines={knownLines}
          onOffsetsChange={setOffsets}
        />
      )}
    </div>
  )
}
```

- [ ] Check types:
```bash
./node_modules/.bin/tsc --noEmit 2>&1 | head -20
```

- [ ] Manual test — open `http://localhost:3000/analysis`:
  - Default 7d preset loads noise data; no tram markers (range > 48h)
  - Click "24h" — chart reloads; tram offset panel appears below (if tram events exist)
  - Drag a slider — marker positions shift immediately on chart
  - Click "Save offsets" — button shows "Saving…" then "Saved HH:MM:SS"
  - Reload page, select 24h again — slider values restore from DB

- [ ] Commit:
```bash
git add app/analysis/page.tsx
git commit -m "feat: add Analysis page (time range + correlation chart + offset panel)"
```

---

### Task 13: End-to-end validation + DB migration on Vercel

- [ ] Run migration locally:
```bash
curl -s http://localhost:3000/api/setup | cat
```
Expected: `{"ok":true}` with `tram_line_offsets` table created.

- [ ] Add env vars to Vercel (via dashboard or CLI):
  - `APP_PIN` — your chosen PIN (e.g. `1234`)
  - `SESSION_SECRET` — a random 32+ character string (generate with `openssl rand -base64 32`)

- [ ] Deploy to Vercel:
```bash
git push
```
Then visit the Vercel deployment URL. Should redirect to `/login`.

- [ ] Run migration on production:
```bash
curl -s https://<your-vercel-url>/api/setup | cat
```

- [ ] Full flow check on production:
  1. Visit app → `/login`
  2. Wrong PIN → "Incorrect PIN"
  3. Correct PIN → `/`
  4. Navigate to `/analysis` → chart loads
  5. Switch to 24h → tram offset panel appears
  6. Save an offset → persists on reload
  7. Logout → back to `/login`
  8. Verify Pi daemon still works: check sensor readings continue to appear on the dashboard (Pi uses `/api/ingest` which is excluded from auth)

- [ ] Commit:
```bash
git commit --allow-empty -m "chore: Phase 1 complete — PIN auth + analysis page + tram offsets"
```

---

## Phase 2 (separate plan)

Phase 2 adds Apple Health CSV upload (`health_readings` table, `/api/health-data/*` routes, `HealthUploadPanel` component, Sleep/HR/HRV chart layers). It will be written as a separate plan once Phase 1 is deployed and verified.
