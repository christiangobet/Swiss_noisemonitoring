// lib/detector.ts

export const DETECTOR_PARAMS = {
  BG_WIN:          30,   // background window (readings)
  DELTA_DB:         8,   // dB above background median to open
  VOTE_WIN:        10,   // voting window width
  VOTE_ON:          5,   // votes required to open a passage
  SLOPE_WIN:        5,   // consecutive declining readings required to close
  CLOSE_MARGIN:     3,   // dB: how close to threshold to allow close
  MIN_PASSAGE_SEC:  8,   // discard passages shorter than this
} as const

export interface DetectorReading {
  id: bigint | number
  tsMs: number  // Unix ms
  db: number    // calibrated dB (db_cal) or raw (db_raw) — caller decides
}

export interface DetectedPassage {
  startMs: number
  endMs: number
  readingIds: Array<bigint | number>
}

/** Causal 5-point running average (returns null for early points). */
function causalAvg5(vals: (number | null)[], i: number): number | null {
  const win = vals.slice(Math.max(0, i - 4), i + 1).filter((v): v is number => v !== null)
  if (win.length === 0) return null
  return win.reduce((a, b) => a + b, 0) / win.length
}

/** Rolling median of last `n` values ending at index i (exclusive). */
function rollingMedian(vals: number[], i: number, n: number): number | null {
  const win = vals.slice(Math.max(0, i - n), i).filter(v => isFinite(v))
  if (win.length === 0) return null
  const sorted = [...win].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * Detect tram passages in a chronologically ordered array of readings.
 * Returns one DetectedPassage per detected event (duration-gated).
 */
export function detectPassages(readings: DetectorReading[]): DetectedPassage[] {
  const {
    BG_WIN, DELTA_DB, VOTE_WIN, VOTE_ON,
    SLOPE_WIN, CLOSE_MARGIN, MIN_PASSAGE_SEC,
  } = DETECTOR_PARAMS

  if (readings.length < VOTE_WIN) return []

  const dbs = readings.map(r => r.db)

  // Pre-compute threshold and causal 5-pt avg for each index
  const thresholds = readings.map((_, i) => {
    const med = rollingMedian(dbs, i, BG_WIN)
    return med === null ? null : med + DELTA_DB
  })
  const avg5 = readings.map((_, i) => causalAvg5(dbs, i))

  const candidates: Array<{ startIdx: number; endIdx: number }> = []
  let passageStart = -1

  for (let i = 0; i < readings.length; i++) {
    const winStart = Math.max(0, i - VOTE_WIN + 1)
    let votes = 0
    for (let w = winStart; w <= i; w++) {
      const thr = thresholds[w]
      if (thr !== null && dbs[w] > thr) votes++
    }

    // Open
    if (votes >= VOTE_ON && passageStart === -1) {
      passageStart = i
      continue
    }

    // Close
    if (passageStart !== -1 && i >= SLOPE_WIN) {
      const g5Now  = avg5[i]
      const thrNow = thresholds[i]

      let declining = true
      for (let k = i - SLOPE_WIN + 1; k <= i; k++) {
        const a = avg5[k - 1]
        const b = avg5[k]
        if (a === null || b === null || b > a) { declining = false; break }
      }

      const nearBaseline = g5Now !== null && thrNow !== null && g5Now < thrNow + CLOSE_MARGIN

      if (declining && nearBaseline) {
        candidates.push({ startIdx: passageStart, endIdx: i })
        passageStart = -1
      }
    }
  }

  // Flush open passage at end of array
  if (passageStart !== -1) {
    candidates.push({ startIdx: passageStart, endIdx: readings.length - 1 })
  }

  // Duration gate + build output
  const passages: DetectedPassage[] = []
  for (const c of candidates) {
    const startMs = readings[c.startIdx].tsMs
    const endMs   = readings[c.endIdx].tsMs
    if (endMs - startMs < MIN_PASSAGE_SEC * 1000) continue
    passages.push({
      startMs,
      endMs,
      readingIds: readings.slice(c.startIdx, c.endIdx + 1).map(r => r.id),
    })
  }
  return passages
}
