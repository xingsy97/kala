import { describe, expect, it } from 'vitest'
import { decideRegressionGate, type PairedObservation } from './regression-gate.js'

const HASH_A = 'a'.repeat(64); const HASH_B = 'b'.repeat(64)
const rules = { maxSuccessRateDropPp: 2, maxNewCriticalDefects: 0, maxTestGamingRate: 0, maxP95CostIncreasePct: 15, allowedFlakeRate: 0.1, confidenceLevel: 0.95 }
const pair = (taskId: string, baseline: boolean, candidate: boolean, repeatIndex = 0): PairedObservation => ({ taskId, repeatIndex, baseline: { passed: baseline, costUsd: 1, latencyMs: 100, evidenceRef: 'baseline:' + taskId + ':' + repeatIndex }, candidate: { passed: candidate, costUsd: 1, latencyMs: 90, evidenceRef: 'candidate:' + taskId + ':' + repeatIndex } })

describe('flake-aware paired regression gate', () => {
  it('blocks a deterministic success regression with paired statistics', () => {
    const decision = decideRegressionGate({ gateId: 'gate', baselineConfigHash: HASH_A, candidateConfigHash: HASH_B, observations: [pair('one', true, false), pair('two', true, true), pair('three', true, true)], rules })
    expect(decision).toMatchObject({ decision: 'block', statistics: { pairedWins: 0, pairedLosses: 1, pairedTies: 2, baselineSuccessRate: 1, candidateSuccessRate: 2 / 3 } })
    expect(decision.statistics).toMatchObject({ confidenceInterval: { method: 'paired-bootstrap', samples: 10_000 }, evidenceCompleteness: { baseline: 1, candidate: 1, completePairs: 3, totalPairs: 3 }, pareto: { relation: 'tradeoff' } })
    expect(decision.violations.map((value) => value.rule)).toContain('success-rate-drop')
  })

  it('classifies flakes and infrastructure failures as indeterminate instead of deterministic Agent regression', () => {
    const observations = [pair('flaky', true, true, 0), pair('flaky', false, true, 1), { ...pair('infra', true, false), candidate: { ...pair('infra', true, false).candidate, infrastructureFailure: true } }]
    const decision = decideRegressionGate({ gateId: 'gate', baselineConfigHash: HASH_A, candidateConfigHash: HASH_B, observations, rules: { ...rules, allowedFlakeRate: 1 } })
    expect(decision).toMatchObject({ decision: 'indeterminate', flakyTasks: ['flaky'], infrastructureFailures: ['infra'] })
  })

  it('passes matched improvements without fabricating unmatched comparisons', () => {
    const decision = decideRegressionGate({ gateId: 'gate', baselineConfigHash: HASH_A, candidateConfigHash: HASH_B, observations: [pair('one', false, true), pair('two', true, true)], rules })
    expect(decision).toMatchObject({ decision: 'pass', violations: [], pairedTasks: 2, statistics: { pairedWins: 1, pairedLosses: 0 } })
    expect(decision.statistics?.taskDeltas).toEqual([{ taskId: 'one', baseline: 0, candidate: 1, delta: 1, repeats: 1 }, { taskId: 'two', baseline: 1, candidate: 1, delta: 0, repeats: 1 }])
  })

  it('reports repeated-run variance, evidence completeness, and cost-latency-quality Pareto dominance', () => {
    const observations = [pair('one', true, true, 0), pair('one', true, true, 1), pair('two', false, true, 0), pair('two', false, true, 1)].map((value) => ({ ...value, candidate: { ...value.candidate, costUsd: 0.5, latencyMs: 50 } }))
    const decision = decideRegressionGate({ gateId: 'methodology', baselineConfigHash: HASH_A, candidateConfigHash: HASH_B, observations, rules })
    expect(decision.statistics).toMatchObject({ repeatedRunVariance: { baseline: 0, candidate: 0, taskCount: 2 }, evidenceCompleteness: { baseline: 1, candidate: 1, completePairs: 4, totalPairs: 4 }, pareto: { relation: 'candidate_dominates' } })
  })
})
