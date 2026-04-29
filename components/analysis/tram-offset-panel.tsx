'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { TramLineOffset } from './correlation-chart'

const LINE_COLORS: Record<string, string> = { '2': '#f59e0b', '3': '#60a5fa' }
const DEFAULT_LINE_COLOR = '#a78bfa'

interface Props {
  knownLines: { line: string; direction: string }[]
  onOffsetsChange: (offsets: TramLineOffset[]) => void
}

export default function TramOffsetPanel({ knownLines, onOffsetsChange }: Props) {
  const [offsetMap, setOffsetMap] = useState<Record<string, number>>({})
  const [saving, setSaving]       = useState(false)
  const [savedAt, setSavedAt]     = useState<string | null>(null)

  function toArray(map: Record<string, number>): TramLineOffset[] {
    return knownLines.map(({ line, direction }) => ({
      line,
      direction,
      offset_sec: map[`${line}|${direction}`] ?? 0,
    }))
  }

  useEffect(() => {
    fetch('/api/tram-offsets')
      .then(r => r.json())
      .then(({ offsets }: { offsets: TramLineOffset[] }) => {
        const map: Record<string, number> = {}
        for (const o of offsets) map[`${o.line}|${o.direction}`] = o.offset_sec
        setOffsetMap(map)
        onOffsetsChange(toArray(map))
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleSlider(line: string, direction: string, value: number) {
    const next = { ...offsetMap, [`${line}|${direction}`]: value }
    setOffsetMap(next)
    onOffsetsChange(toArray(next))
  }

  function handleReset() {
    const next: Record<string, number> = {}
    for (const { line, direction } of knownLines) next[`${line}|${direction}`] = 0
    setOffsetMap(next)
    onOffsetsChange(toArray(next))
  }

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await Promise.all(
        knownLines.map(({ line, direction }) =>
          fetch('/api/tram-offsets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              line,
              direction,
              offset_sec: offsetMap[`${line}|${direction}`] ?? 0,
            }),
          })
        )
      )
      setSavedAt(new Date().toLocaleTimeString('de-CH'))
    } finally {
      setSaving(false)
    }
  }, [knownLines, offsetMap])

  if (knownLines.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Tram Schedule Offset</CardTitle>
        <p className="text-xs text-muted-foreground">
          Drag to align markers with noise peaks. Shifts apply to the chart immediately.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {knownLines.map(({ line, direction }) => {
          const val   = offsetMap[`${line}|${direction}`] ?? 0
          const color = LINE_COLORS[line] ?? DEFAULT_LINE_COLOR
          return (
            <div key={`${line}|${direction}`} className="grid grid-cols-[100px_1fr_48px] items-center gap-3">
              <span className="text-xs font-medium truncate" style={{ color }}>
                Line {line} · {direction}
              </span>
              <input
                type="range"
                min={-60}
                max={60}
                step={1}
                value={val}
                onChange={e => handleSlider(line, direction, Number(e.target.value))}
                style={{ accentColor: color }}
                className="w-full"
              />
              <span className="text-xs font-mono text-right text-muted-foreground">
                {val > 0 ? `+${val}s` : `${val}s`}
              </span>
            </div>
          )
        })}
        <div className="flex items-center justify-between pt-1">
          <button
            onClick={handleReset}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Reset all
          </button>
          <div className="flex items-center gap-3">
            {savedAt && (
              <span className="text-xs text-muted-foreground">Saved {savedAt}</span>
            )}
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save offsets'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
