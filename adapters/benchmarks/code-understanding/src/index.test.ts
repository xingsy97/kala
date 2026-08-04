import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CODE_UNDERSTANDING_METRIC_NAMES, codeUnderstandingMetrics, createCodeUnderstandingAdapter,
  deriveCodeUnderstandingMetrics, deriveTraceReadSequence, parseCodeUnderstandingObservation, type CodeUnderstandingObservation,
} from './index.js'

const perfect: CodeUnderstandingObservation = {
  k: 3,
  rankedFiles: ['src/entry.ts', 'src/config.ts', 'src/runtime.ts'],
  rankedSymbols: ['src/entry.ts#start', 'src/config.ts#load', 'src/runtime.ts#render'],
  readSequence: ['src/config.ts', 'README.md', 'src/runtime.ts'],
  predictedDependencyEdges: [['src/entry.ts#start', 'src/config.ts#load'], ['src/entry.ts#start', 'src/runtime.ts#render']],
  oracle: {
    repositoryFiles: ['README.md', 'package.json', 'src/entry.ts', 'src/config.ts', 'src/runtime.ts'],
    relevantFiles: ['src/entry.ts', 'src/config.ts', 'src/runtime.ts'],
    relevantSymbols: ['src/entry.ts#start', 'src/config.ts#load', 'src/runtime.ts#render'],
    dependencyEdges: [['src/entry.ts#start', 'src/config.ts#load'], ['src/entry.ts#start', 'src/runtime.ts#render']],
  },
}

describe('Code Understanding adapter', () => {
  it('declares all six localization metrics and derives perfect scores from verifier observations', () => {
    expect(createCodeUnderstandingAdapter().descriptor).toMatchObject({ id: 'code-understanding', nativePrimaryMetric: 'file_recall_at_k' })
    expect(CODE_UNDERSTANDING_METRIC_NAMES).toHaveLength(6)
    expect(deriveCodeUnderstandingMetrics(perfect)).toEqual({
      file_recall_at_k: 1, symbol_recall_at_k: 1, first_relevant_read_rank: 1, irrelevant_read_ratio: 1 / 3,
      dependency_edge_precision: 1, dependency_edge_recall: 1,
    })
  })

  it('uses explicit empty and missing-observation conventions', () => {
    const metrics = deriveCodeUnderstandingMetrics({ ...perfect, readSequence: [], predictedDependencyEdges: [], oracle: { ...perfect.oracle, dependencyEdges: [] } })
    expect(metrics).toMatchObject({ first_relevant_read_rank: 0, irrelevant_read_ratio: 1, dependency_edge_precision: 1, dependency_edge_recall: 1 })
    expect(codeUnderstandingMetrics([])).toMatchObject({ file_recall_at_k: 0, verifier_protocol_valid: false })
  })

  it('rejects malformed, duplicate, non-finite, and schema-expanded observations', () => {
    for (const value of [
      'not-json',
      JSON.stringify({ ...perfect, k: 0 }),
      JSON.stringify({ ...perfect, rankedFiles: ['src/entry.ts', 'src/entry.ts'] }),
      JSON.stringify({ ...perfect, extra: true }),
      JSON.stringify({ ...perfect, oracle: { ...perfect.oracle, relevantFiles: [] } }),
      JSON.stringify({ ...perfect, predictedDependencyEdges: [perfect.predictedDependencyEdges[0], perfect.predictedDependencyEdges[0]] }),
    ]) expect(parseCodeUnderstandingObservation(value)).toBeNull()
  })

  it('derives read order from captured native command events instead of self-report', () => {
    const events = [
      { method: 'item/started', params: { item: { id: '1', type: 'commandExecution', command: 'cat README.md' } } },
      { method: 'item/completed', params: { item: { id: '1', type: 'commandExecution', command: 'cat README.md', output: 'README.md' } } },
      { type: 'tool_call', id: '2', arguments: { cmd: 'sed -n 1,80p src/config.ts && cat src/runtime.ts' } },
      { type: 'agentMessage', text: 'src/entry.ts is relevant but was not read' },
    ]
    expect(deriveTraceReadSequence(events, perfect.oracle.repositoryFiles)).toEqual(['README.md', 'src/config.ts', 'src/runtime.ts'])
  })

  it('computes recall, read ratio, and edge precision/recall from set definitions', () => {
    const metrics = deriveCodeUnderstandingMetrics({
      ...perfect, k: 2, rankedFiles: ['README.md', 'src/config.ts', 'src/runtime.ts'], rankedSymbols: ['README.md#title', 'src/config.ts#load'],
      readSequence: ['README.md', 'package.json', 'src/runtime.ts', 'src/config.ts'],
      predictedDependencyEdges: [['src/entry.ts#start', 'src/config.ts#load'], ['src/runtime.ts#render', 'other#wrong']],
    })
    expect(metrics).toEqual({
      file_recall_at_k: 1 / 3, symbol_recall_at_k: 1 / 3, first_relevant_read_rank: 3, irrelevant_read_ratio: 1 / 2,
      dependency_edge_precision: 1 / 2, dependency_edge_recall: 1 / 2,
    })
  })

  it('keeps bounded metrics in [0,1] and is monotone when a relevant item enters top-k', () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 2, maxLength: 20 }),
      fc.integer({ min: 1, max: 20 }),
      (universe, requestedK) => {
        const relevant = universe.slice(0, Math.max(1, Math.floor(universe.length / 2)))
        const irrelevant = universe.slice(relevant.length)
        const k = Math.min(requestedK, universe.length)
        const ranked = [...irrelevant, ...relevant]
        const before = deriveCodeUnderstandingMetrics({ ...perfect, k, rankedFiles: ranked, oracle: { ...perfect.oracle, relevantFiles: relevant } })
        const promoted = relevant.findIndex((value) => !ranked.slice(0, k).includes(value))
        if (promoted >= 0 && k > 0) {
          const afterRanking = [...ranked]
          const index = afterRanking.indexOf(relevant[promoted]!)
          ;[afterRanking[k - 1], afterRanking[index]] = [afterRanking[index]!, afterRanking[k - 1]!]
          const after = deriveCodeUnderstandingMetrics({ ...perfect, k, rankedFiles: afterRanking, oracle: { ...perfect.oracle, relevantFiles: relevant } })
          expect(after.file_recall_at_k).toBeGreaterThanOrEqual(before.file_recall_at_k)
        }
        for (const name of ['file_recall_at_k', 'symbol_recall_at_k', 'irrelevant_read_ratio', 'dependency_edge_precision', 'dependency_edge_recall'] as const) {
          expect(before[name]).toBeGreaterThanOrEqual(0)
          expect(before[name]).toBeLessThanOrEqual(1)
        }
      },
    ), { numRuns: 300 })
  })
})
