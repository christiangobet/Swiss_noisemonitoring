# Recording Persistence & Source Management

**Date:** 2026-04-25  
**Status:** Approved

## Problem

`RecorderProvider` already lives at root level (`app-shell.tsx`), so the mic and GM1356 pipelines survive navigation. However three bugs break the "record once, navigate freely" promise:

1. **Settings desync.** `settings/page.tsx` reads/writes `localStorage` directly. Changing the source name while recording leaves the running recorder flushing under the old name until a page reload.
2. **Double AudioContext in calibration.** `components/calibration/mic-recorder.tsx` owns its own full mic pipeline (RAF loop, flush buffer, device ID reads). If background recording is active the browser is asked to open the same device twice — silent failure on some devices, doubled CPU on others.
3. **No recording indicator outside the dashboard.** Once the user navigates away there is no signal that recording is still happening and no way to stop/start it without going back to the dashboard.

## Approach

Wire all recording state through `RecorderCtx`. Add a global `RecordingPill` component (popover with full controls) embedded in both the sidebar and the mobile nav.

## Architecture

`RecorderProvider` remains at root level in `app-shell.tsx` — no structural change. Changes are additive:

- `deviceLabel` is promoted from a private ref to an exposed context value so settings changes take effect immediately for ongoing flushes.
- A new shared `RecordingPopover` component provides Start/Stop controls accessible from every page.
- Settings and calibration pages consume the context instead of managing their own state.

## Files Changed

| File | Change |
|---|---|
| `lib/recorder-context.tsx` | Add `deviceLabel: string` and `setDeviceLabel: (v: string) => void` to `RecorderCtx` interface and provider value |
| `components/layout/recording-popover.tsx` | **New.** Exports `RecordingPill` (the trigger) and the popover content |
| `components/layout/sidebar.tsx` | Add `<RecordingPill />` in the nav section (below nav links, above footer) |
| `components/layout/mobile-nav.tsx` | Add `<RecordingPill />` as a 28 px strip above the tab bar |
| `app/settings/page.tsx` | Replace local `deviceSource`/`deviceLabel` state with `useRecorder()` values |
| `components/calibration/mic-recorder.tsx` | Replace with thin wrapper that reads `micActive`/`micDb`/`micSource`/`startMic` from `useRecorder()` |

## Component Design

### RecordingPill (trigger)

Shown in both sidebar and mobile nav. Renders a small coloured dot and source name.

```
● roof          ← pulsing green dot + source name, when any source is active
○ not recording ← muted, when idle
```

- "Active" means `micActive || gm1356Active`.
- Clicking opens `RecordingPopover` anchored to the pill.

### RecordingPopover (content)

Uses shadcn `Popover` (already in `components/ui/`). Two sections, one per source type.

**When mic is active:**
```
Mic
● 47.3 dB(A) · roof                    [Stop]
✓ 42 saved · 3s ago
[✦ Tag tram]
```

**When mic is idle:**
```
Mic
Not recording                           [Start]
```

**GM1356 section** follows the same pattern with Connect/Disconnect.

Errors (`micError`, `micSaveError`, `gm1356Error`, `gm1356SaveError`) are shown inline below the relevant button, same style as the dashboard.

### Mobile placement

The `main` element already has `pb-16` to clear the bottom nav. The recording strip sits inside `MobileNav`, above the tab row, rendered only when `micActive || gm1356Active` (so it does not eat space when idle). Height: 28 px. Tapping it opens the popover anchored to the strip.

### Settings page

```tsx
const { micSource, setMicSource, deviceLabel, setDeviceLabel } = useRecorder()
```

- Remove local `deviceSource`, `handleDeviceSource`, `deviceLabel`, `handleDeviceLabel` state and their `useEffect`.
- Keep `deviceId` as local state (informational display only — not in context).
- `setMicSource` already writes `localStorage.tramwatchSource` and updates `micSourceRef` in the provider, so the running recorder immediately uses the new source for subsequent flushes.
- `setDeviceLabel` (new in context) writes `localStorage.tramwatchDeviceLabel` and updates `deviceLabelRef` in the provider.

### Calibration MicRecorder

Replaced entirely. New implementation:

```tsx
export function MicRecorder() {
  const { micActive, micDb, micSource, startMic, micError } = useRecorder()
  if (!micActive) return (
    <Button size="sm" variant="outline" onClick={startMic}>
      <Mic className="h-3 w-3 mr-1" /> Use mic
    </Button>
  )
  return (
    <div className="flex items-center gap-3">
      <span style={{ color: dbColor(micDb) }} className="font-mono text-xl font-bold tabular-nums">
        {micDb !== null ? micDb.toFixed(1) : '—'}
      </span>
      <span className="text-xs text-muted-foreground">dB(A) · {micSource}</span>
      {micError && <span className="text-xs text-destructive">{micError}</span>}
    </div>
  )
}
```

No AudioContext, no RAF loop, no flush buffer. Calibration readings reach the DB through the context's existing background flush. The calibration wizard's `/api/calibration/finish` queries the DB by session window — those readings will be there.

## Data Flow

```
RecorderProvider (root)
  ├── micSourceRef / deviceLabelRef  — used by flush fetch
  ├── micSource / deviceLabel        — React state, exposed in context
  │
  ├── LiveChart (dashboard)          — reads micDb, micPoints, startMic, stopMic, tagTram …
  ├── RecordingPill (sidebar)        — reads micActive, gm1356Active, micSource
  ├── RecordingPopover               — reads/calls all controls
  ├── settings/page.tsx              — reads/writes micSource, deviceLabel via setMicSource, setDeviceLabel
  └── calibration/MicRecorder        — reads micActive, micDb, micSource; calls startMic
```

## Re-render consideration

`useRecorder()` consumers re-render whenever any context value changes. `micDb` and `gm1356Db` update every 250 ms while recording. Sidebar and mobile nav become additional consumers, but both are structurally simple (a dot + label) so 4 Hz re-renders are cheap. Context splitting is not warranted today; revisit if profiling shows jank on low-end mobile.

## Out of scope

- Source rename for in-flight readings already flushed (the new name applies from the next flush batch onward — acceptable)
- `browser-mic.tsx` (Settings test-mic preview card) opens its own AudioContext for preview-only purposes. This is intentional and documented; it does not write to the DB. Leave as-is.
- GM1356 source name management in settings (the GM1356 source name `tramwatchGm1356Source` is read once on context mount; a future iteration can expose `setGm1356Source` the same way)
