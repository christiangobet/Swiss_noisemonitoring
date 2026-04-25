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
            <span className="leading-none">Rec</span>
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
