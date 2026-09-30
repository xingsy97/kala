import { describe, expect, it } from 'vitest'

import type { TimelineEntry } from './session.js'
import { appendTranscriptBaseItems, transcriptBaseItems } from './transcript.js'
import { mergeBySeq } from './session.js'

function timeline(count: number): TimelineEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    ts: '2026-01-01T00:00:00.000Z',
    event: { kind: 'user_message' as const, text: `message-${index}` },
    effects: [],
  }))
}

function fastestOf<T>(run: () => T, attempts = 3): { result: T; duration: number } {
  let started = performance.now()
  let result = run()
  let fastest = { result, duration: performance.now() - started }
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    started = performance.now()
    result = run()
    const candidate = { result, duration: performance.now() - started }
    if (candidate.duration < fastest.duration) fastest = candidate
  }
  return fastest
}

describe('transcript projection performance budget', () => {
  it('projects 5000 timeline entries within the unit budget', () => {
    const entries = timeline(5_000)
    const { result: items, duration } = fastestOf(() => transcriptBaseItems([], entries))
    expect(items).toHaveLength(5_000)
    expect(duration).toBeLessThan(100)
  })

  it('appends a 1000-entry timeline tail to 10000 entries within the merge fast-path budget', () => {
    const entries = timeline(11_000)
    const previous = entries.slice(0, 10_000)
    const added = entries.slice(10_000)
    const { result: merged, duration } = fastestOf(() => mergeBySeq(previous, added))
    expect(merged).toHaveLength(11_000)
    expect(merged[0]).toBe(previous[0])
    expect(merged[10_000]).toBe(added[0])
    expect(duration).toBeLessThan(10)
  })

  it('appends 100 entries to a 5000-item projection within the fast-path budget', () => {
    const entries = timeline(5_100)
    const previousTimeline = entries.slice(0, 5_000)
    const previousItems = transcriptBaseItems([], previousTimeline)
    const { result: items, duration } = fastestOf(() => appendTranscriptBaseItems(previousItems, previousTimeline, entries))
    expect(items).toHaveLength(5_100)
    expect(items![0]).toBe(previousItems[0])
    expect(duration).toBeLessThan(25)
  })
})
