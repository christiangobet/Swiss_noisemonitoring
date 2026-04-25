# Recording Persistence & Source Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire all recording state through `RecorderCtx` so source-name changes take effect immediately, the calibration page reuses the running mic pipeline, and a `RecordingPill` popover accessible from every page lets the user start/stop recording and tag trams without navigating to the dashboard.

**Architecture:** `RecorderProvider` already sits at root level. This plan exposes `deviceLabel`/`setDeviceLabel` from the context, creates a shared `RecordingPill` + popover component placed in both sidebar and mobile nav, and replaces the direct-localStorage reads in Settings and the competing AudioContext in `calibration/MicRecorder` with `useRecorder()` calls.

**Tech Stack:** Next.js 14 App Router, React context, Radix UI Popover (`@radix-ui/react-popover`), shadcn/ui component pattern, TypeScript.

---

## File Map

| File | Action |
|---|---|
| `components/ui/popover.tsx` | Create — Radix Popover wrapper (shadcn pattern) |
| `lib/recorder-context.tsx` | Modify — add `deviceLabel` state + `setDeviceLabel` to context |
| `components/layout/recording-popover.tsx` | Create — `RecordingPill` trigger + popover content |
| `components/layout/app-shell.tsx` | Modify — add `RecordingAwareMain` inner component for dynamic mobile padding |
| `components/layout/sidebar.tsx` | Modify — add `<RecordingPill />` between nav links and footer |
| `components/layout/mobile-nav.tsx` | Modify — add recording strip above tab row using `<RecordingPill />` |
| `app/settings/page.tsx` | Modify — replace local source/label state with `useRecorder()` |
| `components/calibration/mic-recorder.tsx` | Replace — thin wrapper that reads `useRecorder()` instead of owning an AudioContext |

---

## Task 1: Install Radix Popover and create UI primitive

**Files:**
- Create: `components/ui/popover.tsx`

- [ ] **Step 1: Install the Radix Popover package**

```bash
npm install @radix-ui/react-popover
```

Expected: package added to `node_modules`, `package.json` updated.

- [ ] **Step 2: Create the shadcn-style popover wrapper**

Create `components/ui/popover.tsx`:

```tsx
'use client'

import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '@/lib/utils'

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 rounded-md border bg-popover text-popover-foreground shadow-md outline-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
        'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent }
```

- [ ] **Step 3: TypeScript check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/ui/popover.tsx package.json package-lock.json
git commit -m "feat: add Radix Popover UI primitive"
```

---

## Task 2: Expose deviceLabel in RecorderCtx

**Files:**
- Modify: `lib/recorder-context.tsx`

- [ ] **Step 1: Add `deviceLabel` and `setDeviceLabel` to the context interface**

In `lib/recorder-context.tsx`, find the `RecorderCtx` interface (line ~99) and add two lines at the end of the Mic section, after `setMicSource`:

```typescript
// existing interface lines …
  setMicSource: (s: string) => void
  // ADD:
  deviceLabel:    string
  setDeviceLabel: (v: string) => void
```

- [ ] **Step 2: Add the `deviceLabel` React state in the provider**

In `RecorderProvider`, after the existing GM1356 state block (around line 166), add:

```typescript
  const [deviceLabel, setDeviceLabelSt] = useState('')
```

- [ ] **Step 3: Set state from localStorage in the mount useEffect**

Find the mount `useEffect` that reads device identity (around line 203). It already has:

```typescript
    const label = localStorage.getItem('tramwatchDeviceLabel') ?? ''
    deviceLabelRef.current = label
```

Add one line immediately after those two:

```typescript
    setDeviceLabelSt(label)
```

- [ ] **Step 4: Add the `setDeviceLabel` callback**

After the existing `setMicSource` callback (around line 201), add:

```typescript
  const setDeviceLabel = useCallback((v: string) => {
    deviceLabelRef.current = v
    setDeviceLabelSt(v)
    localStorage.setItem('tramwatchDeviceLabel', v)
  }, [])
```

- [ ] **Step 5: Add both to the context value object**

Find the `const value: RecorderCtx = { … }` block near the bottom of the provider. Add the two new fields:

```typescript
  const value: RecorderCtx = {
    micActive, micDb, micPoints, micSource, micError, micSaveError, lastSavedMs, savedCount,
    bands, tramScore, manualTags, tagFlash,
    startMic, stopMic, tagTram, setMicSource,
    deviceLabel, setDeviceLabel,            // ← ADD
    gm1356Active, gm1356Db, gm1356Peak, gm1356Points, gm1356Source,
    gm1356Error, gm1356SaveError, gm1356LastSavedMs, gm1356SavedCount,
    startGm1356, stopGm1356,
  }
```

- [ ] **Step 6: TypeScript check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/recorder-context.tsx
git commit -m "feat: expose deviceLabel/setDeviceLabel in RecorderCtx"
```

---

## Task 3: Create RecordingPill + popover component

**Files:**
- Create: `components/layout/recording-popover.tsx`

- [ ] **Step 1: Create the file**

Create `components/layout/recording-popover.tsx` with the following full content:

```tsx
'use client'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Mic, MicOff, Usb, Tag } from 'lucide-react'
import { useRecorder } from '@/lib/recorder-context'
import { cn } from '@/lib/utils'

type Side = 'top' | 'right' | 'bottom' | 'left'

export function RecordingPill({
  className,
  popoverSide = 'right',
  mobileStyle = false,
}: {
  className?: string
  popoverSide?: Side
  mobileStyle?: boolean
}) {
  const {
    micActive, micDb, micSource, micError, micSaveError,
    lastSavedMs, savedCount, tagFlash,
    startMic, stopMic, tagTram,
    gm1356Active, gm1356Db, gm1356Source, gm1356Error, gm1356SaveError,
    gm1356LastSavedMs, gm1356SavedCount,
    startGm1356, stopGm1356,
  } = useRecorder()

  const isRecording = micActive || gm1356Active

  const activeSources = [
    micActive    && micSource,
    gm1356Active && gm1356Source,
  ].filter(Boolean) as string[]

  return (
    <Popover>
      <PopoverTrigger asChild>
        {mobileStyle ? (
          <button className={cn(
            'flex-1 flex flex-col items-center justify-center gap-1 text-xs transition-colors',
            isRecording ? 'text-green-400' : 'text-muted-foreground hover:text-foreground',
            className,
          )}>
            <span className={cn(
              'w-5 h-5 rounded-full border-2 flex items-center justify-center',
              isRecording
                ? 'border-green-400 bg-green-400/10 animate-pulse'
                : 'border-muted-foreground/40',
            )}>
              <span className={cn(
                'w-2 h-2 rounded-full',
                isRecording ? 'bg-green-400' : 'bg-muted-foreground/40',
              )} />
            </span>
            <span className="leading-none">{isRecording ? 'Rec' : 'Rec'}</span>
          </button>
        ) : (
          <button className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs transition-colors w-full text-left',
            isRecording
              ? 'text-green-400 hover:bg-accent/50'
              : 'text-muted-foreground hover:bg-accent/50',
            className,
          )}>
            <span className={cn(
              'inline-block w-2 h-2 rounded-full shrink-0',
              isRecording ? 'bg-green-400 animate-pulse' : 'bg-muted-foreground/40',
            )} />
            <span className="truncate">
              {isRecording ? activeSources.join(' · ') : 'not recording'}
            </span>
          </button>
        )}
      </PopoverTrigger>

      <PopoverContent
        side={popoverSide}
        align="end"
        sideOffset={8}
        className="w-72 p-3 space-y-3"
      >
        {/* ── Mic section ─────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Microphone</p>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              {micActive ? (
                <p className="text-sm font-mono font-bold leading-none" style={{
                  color: micDb === null ? '#94a3b8'
                    : micDb >= 75 ? '#f87171'
                    : micDb >= 60 ? '#fbbf24'
                    : '#4ade80',
                }}>
                  {micDb !== null ? `${micDb.toFixed(1)} dB(A)` : 'Waiting…'}
                  <span className="text-[11px] font-normal text-muted-foreground ml-1.5">· {micSource}</span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Not recording</p>
              )}
            </div>
            <Button
              size="sm"
              variant={micActive ? 'destructive' : 'outline'}
              className="h-7 px-2 text-xs gap-1 shrink-0"
              onClick={micActive ? stopMic : startMic}
            >
              {micActive
                ? <><MicOff className="h-3 w-3" />Stop</>
                : <><Mic className="h-3 w-3" />Start</>}
            </Button>
          </div>

          {micActive && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] text-muted-foreground truncate">
                {micSaveError
                  ? <span className="text-orange-400">⚠ {micSaveError}</span>
                  : lastSavedMs
                    ? `✓ ${savedCount} saved · ${Math.round((Date.now() - lastSavedMs) / 1000)}s ago`
                    : 'waiting for first flush…'}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-1.5 text-[10px] gap-1 border-amber-500/50 text-amber-400 hover:bg-amber-500/10 shrink-0"
                onClick={tagTram}
              >
                <Tag className="h-2.5 w-2.5" />
                {tagFlash ? 'Tagged!' : 'Tag tram'}
              </Button>
            </div>
          )}
          {micError && (
            <p className="text-[10px] text-destructive">{micError}</p>
          )}
        </div>

        <div className="border-t border-border" />

        {/* ── GM1356 section ──────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">GM1356 SPL Meter</p>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              {gm1356Active ? (
                <p className="text-sm font-mono font-bold leading-none text-green-400">
                  {gm1356Db !== null ? `${gm1356Db.toFixed(1)} dB(A)` : 'Waiting…'}
                  <span className="text-[11px] font-normal text-muted-foreground ml-1.5">· {gm1356Source}</span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Not connected</p>
              )}
            </div>
            <Button
              size="sm"
              variant={gm1356Active ? 'destructive' : 'outline'}
              className="h-7 px-2 text-xs gap-1 shrink-0"
              onClick={gm1356Active ? stopGm1356 : startGm1356}
            >
              <Usb className="h-3 w-3" />
              {gm1356Active ? 'Disconnect' : 'Connect'}
            </Button>
          </div>

          {gm1356Active && (
            <p className="text-[10px] text-muted-foreground">
              {gm1356SaveError
                ? <span className="text-orange-400">⚠ {gm1356SaveError}</span>
                : gm1356LastSavedMs
                  ? `✓ ${gm1356SavedCount} saved · ${Math.round((Date.now() - gm1356LastSavedMs) / 1000)}s ago`
                  : 'waiting for first flush…'}
            </p>
          )}
          {gm1356Error && (
            <p className="text-[10px] text-destructive">{gm1356Error}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
```

- [ ] **Step 2: TypeScript check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/layout/recording-popover.tsx
git commit -m "feat: add RecordingPill popover component"
```

---

## Task 4: Add RecordingPill to the sidebar

**Files:**
- Modify: `components/layout/sidebar.tsx`

- [ ] **Step 1: Import RecordingPill**

At the top of `components/layout/sidebar.tsx`, add the import after the existing imports:

```tsx
import { RecordingPill } from './recording-popover'
```

- [ ] **Step 2: Add the pill between the nav block and the footer**

The sidebar currently ends with `</nav>` then a footer `<div>`. Add `<RecordingPill />` in a wrapper between them:

```tsx
      {/* Recording status */}
      <div className="px-2 pb-2">
        <RecordingPill popoverSide="right" />
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border">
```

- [ ] **Step 3: TypeScript check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/layout/sidebar.tsx
git commit -m "feat: add RecordingPill to sidebar"
```

---

## Task 5: Add RecordingPill to mobile nav and fix padding

**Files:**
- Modify: `components/layout/app-shell.tsx`
- Modify: `components/layout/mobile-nav.tsx`

- [ ] **Step 1: Add RecordingAwareMain to app-shell**

Replace `components/layout/app-shell.tsx` with:

```tsx
import { Sidebar } from './sidebar'
import { MobileNav } from './mobile-nav'
import { RecorderProvider } from '@/lib/recorder-context'
import { RecordingAwareMain } from './recording-aware-main'

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <RecorderProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <RecordingAwareMain>{children}</RecordingAwareMain>
        <MobileNav />
      </div>
    </RecorderProvider>
  )
}
```

- [ ] **Step 2: Create RecordingAwareMain**

Create `components/layout/recording-aware-main.tsx`:

```tsx
'use client'

import { useRecorder } from '@/lib/recorder-context'
import { cn } from '@/lib/utils'

export function RecordingAwareMain({ children }: { children: React.ReactNode }) {
  const { micActive, gm1356Active } = useRecorder()
  const isRecording = micActive || gm1356Active
  return (
    <main className={cn(
      'flex-1 flex flex-col min-h-screen overflow-auto',
      isRecording ? 'pb-24 md:pb-0' : 'pb-16 md:pb-0',
    )}>
      {children}
    </main>
  )
}
```

- [ ] **Step 3: Update mobile-nav to include the recording strip**

Replace `components/layout/mobile-nav.tsx` with:

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  History,
  FileText,
  Settings,
  Gauge,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { RecordingPill } from './recording-popover'
import { useRecorder } from '@/lib/recorder-context'

const NAV_ITEMS = [
  { href: '/', label: 'Live', icon: Activity },
  { href: '/history', label: 'History', icon: History },
  { href: '/reports', label: 'Reports', icon: FileText },
  { href: '/calibration', label: 'Calibrate', icon: Gauge },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function MobileNav() {
  const pathname = usePathname()
  const { micActive, gm1356Active } = useRecorder()
  const isRecording = micActive || gm1356Active

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-card border-t border-border safe-area-inset-bottom">
      {/* Recording strip — only visible when active */}
      {isRecording && (
        <div className="border-b border-border/40 bg-card/95">
          <RecordingPill popoverSide="top" mobileStyle={false} className="py-1" />
        </div>
      )}
      {/* Tab row */}
      <div className="flex items-stretch h-16">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || (href !== '/' && pathname.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex-1 flex flex-col items-center justify-center gap-1 text-xs transition-colors',
                isActive
                  ? 'text-amber-400'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className={cn('h-5 w-5', isActive && 'text-amber-400')} />
              <span className="leading-none">{label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
```

- [ ] **Step 4: TypeScript check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add components/layout/app-shell.tsx components/layout/recording-aware-main.tsx components/layout/mobile-nav.tsx
git commit -m "feat: add RecordingPill to mobile nav with dynamic bottom padding"
```

---

## Task 6: Wire Settings page to RecorderCtx

**Files:**
- Modify: `app/settings/page.tsx`

- [ ] **Step 1: Add useRecorder import**

At the top of `app/settings/page.tsx`, add:

```tsx
import { useRecorder } from '@/lib/recorder-context'
```

- [ ] **Step 2: Replace local source/label state with context values**

Inside `SettingsPage`, find the current identity block:

```tsx
  const [deviceSource, setDeviceSourceState] = useState<string>('default')
  const [deviceLabel,  setDeviceLabelState]  = useState('')
  const [deviceId,     setDeviceId]          = useState('')

  useEffect(() => {
    let id = localStorage.getItem('tramwatchDeviceId')
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36)
      localStorage.setItem('tramwatchDeviceId', id)
    }
    setDeviceId(id)
    const defaultSrc = id.replace(/-/g, '').slice(0, 8)
    const savedSrc = localStorage.getItem('tramwatchSource')
    const src = savedSrc || defaultSrc
    if (!savedSrc) localStorage.setItem('tramwatchSource', defaultSrc)
    setDeviceSourceState(src)
    setDeviceLabelState(localStorage.getItem('tramwatchDeviceLabel') ?? '')
  }, [])

  const handleDeviceSource = (v: string) => {
    setDeviceSourceState(v)
    localStorage.setItem('tramwatchSource', v)
  }
  const handleDeviceLabel = (v: string) => {
    setDeviceLabelState(v)
    localStorage.setItem('tramwatchDeviceLabel', v)
  }
```

Replace the entire block with:

```tsx
  const { micSource, setMicSource, deviceLabel, setDeviceLabel } = useRecorder()

  // deviceId is informational only — not in context
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
```

- [ ] **Step 3: Update all references in the JSX**

In the JSX of `SettingsPage`, make these replacements:

| Old | New |
|---|---|
| `value={deviceSource}` | `value={micSource}` |
| `handleDeviceSource(v \|\| 'default')` | `setMicSource(v \|\| 'default')` |
| `value={deviceLabel}` | `value={deviceLabel}` *(unchanged)* |
| `handleDeviceLabel(e.target.value)` | `setDeviceLabel(e.target.value)` |

The source name `<Input>` onChange handler currently is:
```tsx
onChange={e => {
  const v = e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  handleDeviceSource(v || 'default')
}}
```
Change to:
```tsx
onChange={e => {
  const v = e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  setMicSource(v || 'default')
}}
```

The label `<Input>` onChange handler currently is:
```tsx
onChange={e => handleDeviceLabel(e.target.value)}
```
Change to:
```tsx
onChange={e => setDeviceLabel(e.target.value)}
```

- [ ] **Step 4: TypeScript check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/settings/page.tsx
git commit -m "fix: wire settings source/label to RecorderCtx — live sync while recording"
```

---

## Task 7: Replace calibration MicRecorder with context-based wrapper

**Files:**
- Replace: `components/calibration/mic-recorder.tsx`

- [ ] **Step 1: Replace the entire file**

Overwrite `components/calibration/mic-recorder.tsx` with:

```tsx
'use client'

import { useRecorder } from '@/lib/recorder-context'
import { Button } from '@/components/ui/button'
import { Mic, MicOff } from 'lucide-react'

export function MicRecorder() {
  const { micActive, micDb, micSource, startMic, stopMic, micError } = useRecorder()

  const dbColor = micDb === null ? '#94a3b8'
    : micDb >= 75 ? '#f87171'
    : micDb >= 60 ? '#fbbf24'
    : '#4ade80'

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Button
        size="sm"
        variant={micActive ? 'destructive' : 'outline'}
        className="h-7 px-2 text-xs gap-1"
        onClick={micActive ? stopMic : startMic}
      >
        {micActive ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
        {micActive ? 'Stop mic' : 'Use mic'}
      </Button>

      {micActive && micDb !== null && (
        <span className="font-mono text-xl font-bold tabular-nums" style={{ color: dbColor }}>
          {micDb.toFixed(1)}
          <span className="text-xs font-normal text-muted-foreground ml-1">dB(A)</span>
        </span>
      )}

      {micActive && (
        <span className="text-xs text-muted-foreground">
          recording as <strong className="text-foreground">{micSource}</strong>
        </span>
      )}

      {micError && (
        <span className="text-xs text-destructive">{micError}</span>
      )}
    </div>
  )
}
```

- [ ] **Step 2: TypeScript check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/calibration/mic-recorder.tsx
git commit -m "fix: calibration MicRecorder now uses RecorderCtx — no competing AudioContext"
```

---

## Task 8: Browser smoke test

No automated test suite exists. Verify manually:

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Sidebar pill — idle state**

Open `http://localhost:3000`. Before starting the mic, the sidebar should show a gray `○ not recording` pill below the nav links. Clicking it opens the popover with Start and Connect buttons.

- [ ] **Step 3: Start recording from popover**

Click `Start` in the mic section of the popover. The pill should turn green and pulse, showing the source name. The `savedCount` and last-saved timestamp should appear in the popover within ~5 s.

- [ ] **Step 4: Navigate away — recording continues**

Click `History` in the sidebar. The pill should still be green and pulsing with the same source name. The DB is still receiving readings (verify by reopening the popover — the saved count should keep incrementing).

- [ ] **Step 5: Tag tram from any page**

While on the History page, open the popover and click `Tag tram`. The `Tagged!` label should flash briefly.

- [ ] **Step 6: Settings source name change syncs immediately**

Navigate to Settings. Change the Source name field (e.g., append `-2`). Navigate back to Dashboard. The live chart should start a new line under the new source name within 2 s (the next `fetchLive` poll). The popover pill should also display the updated source name immediately.

- [ ] **Step 7: Calibration page — no double AudioContext**

Navigate to Calibration. If the mic is active (from step 3), `MicRecorder` should show the live dB reading and a `Stop mic` button — **not** a `Use mic` button that would open a second stream.  If the mic is idle, clicking `Use mic` in `MicRecorder` starts the same background recorder.

- [ ] **Step 8: Mobile — recording strip appears when active**

Resize the browser to mobile width (< 768 px). When recording is active the strip above the tab bar should appear. When not recording the strip should be absent and the tab bar sits at the bottom of the screen normally.

- [ ] **Step 9: Final TypeScript check**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: no errors.
