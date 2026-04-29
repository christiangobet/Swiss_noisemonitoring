'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  BarChart2,
  History,
  FileText,
  Settings,
  Gauge,
  LogOut,
  Radio,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { RecordingPill } from './recording-popover'

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: Activity },
  { href: '/history', label: 'History', icon: History },
  { href: '/analysis', label: 'Analysis', icon: BarChart2 },
  { href: '/reports', label: 'Reports', icon: FileText },
  { href: '/calibration', label: 'Calibration', icon: Gauge },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden md:flex flex-col w-56 min-h-screen bg-card border-r border-border">
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-5 border-b border-border">
        <Radio className="h-5 w-5 text-amber-400" />
        <span className="font-semibold text-foreground tracking-tight">
          {process.env.NEXT_PUBLIC_APP_TITLE ?? 'TramWatch'}
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-2 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || (href !== '/' && pathname.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Recording status */}
      <div className="px-2 pb-2">
        <RecordingPill popoverSide="right" />
      </div>

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

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border">
        <p className="text-xs text-muted-foreground">Römerhofplatz · Zürich</p>
        <p className="text-xs text-muted-foreground">ES II · 55/45 dB(A)</p>
      </div>
    </aside>
  )
}
