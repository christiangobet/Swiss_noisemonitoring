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
