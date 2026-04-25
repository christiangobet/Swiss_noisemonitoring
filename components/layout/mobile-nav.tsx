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
      {isRecording && (
        <div className="border-b border-border/40 bg-card/95">
          <RecordingPill popoverSide="top" mobileStyle={false} className="py-1" />
        </div>
      )}
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
