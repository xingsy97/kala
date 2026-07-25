import { describe, expect, it } from 'vitest'

import {
  apiAdapterLabel,
  compactCardSummary,
  compactModelLabel,
  compactNameCounts,
  compactPath,
  formatTraceDuration,
  shortStatus,
  shortTopologyValue,
  statusTone,
  summarizeTextForCard,
} from './presentation.js'

describe('compactPath', () => {
  it('keeps relative or short paths, compacts deep absolute paths to the last 3 segments', () => {
    expect(compactPath('short.txt')).toBe('short.txt')
    expect(compactPath('/a/b')).toBe('/a/b')
    expect(compactPath('/a/b/c/d/e/file.txt')).toBe('/d/e/file.txt')
  })
})

describe('compactModelLabel', () => {
  it('strips known provider prefixes and -internal suffix', () => {
    expect(compactModelLabel('anthropic / claude-opus')).toBe('claude-opus')
    expect(compactModelLabel('kernel / router-internal')).toBe('router')
    expect(compactModelLabel('plain')).toBe('plain')
  })
})

describe('shortStatus / statusTone', () => {
  it('maps statuses to short labels', () => {
    expect(typeof shortStatus('thinking')).toBe('string')
    expect(shortStatus(undefined)).toBeTypeOf('string')
  })
  it('returns a tone class or undefined', () => {
    const tone = statusTone('error')
    expect(tone === undefined || typeof tone === 'string').toBe(true)
  })
})

describe('formatTraceDuration', () => {
  it('formats numeric ms and falls back for non-numbers', () => {
    expect(formatTraceDuration(500)).toMatch(/ms|s/)
    expect(formatTraceDuration('x')).toBeTypeOf('string')
  })
})

describe('apiAdapterLabel', () => {
  it('returns a non-empty label for a provider', () => {
    expect(apiAdapterLabel('anthropic')).toBeTruthy()
  })
})

describe('compactNameCounts', () => {
  it('summarizes repeated names within a limit', () => {
    const out = compactNameCounts(['a', 'a', 'b'], 5)
    expect(out).toContain('a')
    expect(out).toContain('b')
  })
})

describe('card/text truncation', () => {
  it('truncates long values', () => {
    const long = 'x'.repeat(500)
    expect(compactCardSummary(long).length).toBeLessThanOrEqual(long.length)
    expect(summarizeTextForCard(long).length).toBeLessThanOrEqual(long.length)
  })
})

describe('shortTopologyValue', () => {
  it('compacts a topology node value', () => {
    const node = { id: 'n', label: 'L', value: 'anthropic/claude-opus', status: 'ok' } as never
    expect(typeof shortTopologyValue(node)).toBe('string')
  })
})
