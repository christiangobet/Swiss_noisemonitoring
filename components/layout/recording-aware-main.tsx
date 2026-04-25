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
