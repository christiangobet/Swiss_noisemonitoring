export const dynamic = 'force-dynamic'

import { TopBar } from '@/components/dashboard/top-bar'
import { NextTrams } from '@/components/dashboard/next-trams'
import { LiveChart } from '@/components/dashboard/live-chart'
import { StatCards } from '@/components/dashboard/stat-cards'

export default function DashboardPage() {
  return (
    <div className="flex flex-col h-full">
      <TopBar />
      <NextTrams />
      <div className="flex-1 p-4 space-y-4 overflow-auto">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Live — Last 5 Minutes
            </h2>
            <span className="text-xs text-muted-foreground animate-pulse">● Live</span>
          </div>
          <LiveChart />
        </div>
        <StatCards />
      </div>
    </div>
  )
}
