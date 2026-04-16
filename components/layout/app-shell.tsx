import { Sidebar } from './sidebar'
import { MobileNav } from './mobile-nav'

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-screen pb-16 md:pb-0 overflow-auto">
        {children}
      </main>
      <MobileNav />
    </div>
  )
}
