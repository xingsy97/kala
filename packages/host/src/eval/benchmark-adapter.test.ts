import { describe, expect, it } from 'vitest'

import { getAdapter, listAdapters } from './adapter-registry.js'
import { swebenchAdapter } from './swebench-adapter.js'
import { terminalBenchAdapter } from './terminal-bench-adapter.js'

describe('BenchmarkAdapter registry', () => {
  it('lists both concrete adapters', () => {
    expect(listAdapters().slice().sort()).toEqual(['swe-bench', 'terminal-bench'])
  })

  it('looks up each adapter by kind and kind field matches registry key', () => {
    expect(getAdapter('swe-bench').kind).toBe('swe-bench')
    expect(getAdapter('terminal-bench').kind).toBe('terminal-bench')
  })

  it('throws for unknown kind', () => {
    expect(() => getAdapter('webarena' as never)).toThrow(/unknown benchmark kind/)
  })

  it('derives a layout with progress and summary paths for each adapter', () => {
    const a = swebenchAdapter.layout('/tmp/root', 'run-a')
    expect(a.progressPath).toContain('run-a')
    expect(a.summaryPath).toContain('run-a')
    const b = terminalBenchAdapter.layout('/tmp/root', 'run-b')
    expect(b.progressPath).toContain('run-b')
    expect(b.summaryPath).toContain('run-b')
  })
})

describe('explainScore', () => {
  it('SWE-bench explanation names the official harness and uses "resolved"', () => {
    const exp = swebenchAdapter.explainScore({ runId: 'r', total: 15, resolved: 12, results: [] })
    expect(exp.headline.length).toBeGreaterThan(0)
    expect(exp.headline).toContain('12')
    expect(exp.headline).toContain('15')
    expect(exp.officialTerm).toBe('resolved')
    expect(exp.details.resolvedPct).toBe(80)
  })

  it('Terminal-Bench explanation names the parser + exit-code contract', () => {
    const exp = terminalBenchAdapter.explainScore({
      runId: 'r', total: 5, resolved: 3, unresolved: 1, errored: 1, accuracy: 0.6, durationMs: 0,
    })
    expect(exp.headline.length).toBeGreaterThan(0)
    expect(exp.headline).toContain('Terminal-Bench')
    expect(exp.officialTerm).toBe('resolved')
    expect(exp.details.accuracyPct).toBe(60)
  })
})
