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
