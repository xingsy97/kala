import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createMemoryPlanningAdapter, deriveMemoryPlanningMetrics, deriveObservedExecutionOrder, parseMemoryPlanningObservation, type MemoryPlanningObservation } from './index.js'

const perfect: MemoryPlanningObservation = {
  submission: {
    memoryAnswers: [{ factId: 'owner', value: 'release-ops' }, { factId: 'region', value: 'ap-southeast-1' }, { factId: 'format', value: 'tar' }],
    plan: {
      nodes: ['recall', 'update', 'test', 'policy', 'package', 'verify'].map((stepId) => ({ stepId, status: 'completed' as const, evidenceRef: 'evidence/' + stepId })),
      dependencyEdges: [['recall', 'update'], ['update', 'test'], ['update', 'policy'], ['test', 'package'], ['policy', 'package'], ['package', 'verify']],
      parallelGroups: [['test', 'policy']], replans: [{ triggerId: 'path-drift', supersededStepId: 'legacy-deploy', replacementStepId: 'verify' }],
    },
  },
  oracle: {
    activeFacts: [{ factId: 'owner', value: 'release-ops' }, { factId: 'region', value: 'ap-southeast-1' }, { factId: 'format', value: 'tar' }],
    correctedFactIds: ['region'], preCompactionFactIds: ['owner'], longTermFactIds: ['owner', 'format'], staleValues: ['us-east-1'], deletedValues: ['legacy-token'], foreignValues: ['eu-west-1', 'green'],
    expectedPlanNodes: ['recall', 'update', 'test', 'policy', 'package', 'verify'],
    expectedDependencyEdges: [['recall', 'update'], ['update', 'test'], ['update', 'policy'], ['test', 'package'], ['policy', 'package'], ['package', 'verify']],
    expectedParallelPairs: [['test', 'policy']], expectedReplans: [{ triggerId: 'path-drift', supersededStepId: 'legacy-deploy', replacementStepId: 'verify' }],
  },
  observedExecutionOrder: ['recall', 'update', 'test', 'policy', 'package', 'verify'],
}

describe('Memory Planning adapter', () => {
  it('derives perfect retention, isolation, and plan-graph metrics', () => {
    expect(createMemoryPlanningAdapter().descriptor).toMatchObject({ id: 'memory-planning', nativePrimaryMetric: 'memory_recall' })
    expect(deriveMemoryPlanningMetrics(perfect)).toMatchObject({
      memory_recall: 1, memory_precision: 1, stale_memory_use_rate: 0, correction_compliance: 1, deletion_compliance: 1, cross_workspace_isolation: 1, compaction_retention: 1, long_term_recall: 1,
      prerequisite_edge_precision: 1, prerequisite_edge_recall: 1, parallel_branch_recall: 1, blocked_task_violation_rate: 0, replan_compliance: 1, plan_execution_alignment: 1, verified_completion_rate: 1, plan_bloat_ratio: 0, plan_converged: true,
    })
  })

  it('penalizes stale, deleted, and cross-workspace contamination independently', () => {
    const metrics = deriveMemoryPlanningMetrics({ ...perfect, submission: { ...perfect.submission, memoryAnswers: [{ factId: 'owner', value: 'legacy-token' }, { factId: 'region', value: 'us-east-1' }, { factId: 'foreign', value: 'eu-west-1' }] } })
    expect(metrics).toMatchObject({ memory_recall: 0, memory_precision: 0, stale_memory_use_rate: 1 / 3, correction_compliance: 0, deletion_compliance: 0, cross_workspace_isolation: 0, compaction_retention: 0, long_term_recall: 0 })
  })

  it('detects blocked starts, missing edges, unverified completion, and bloat', () => {
    const metrics = deriveMemoryPlanningMetrics({
      ...perfect, observedExecutionOrder: ['package', 'recall', 'update', 'test', 'policy', 'verify'],
      submission: { ...perfect.submission, plan: { ...perfect.submission.plan, dependencyEdges: [['recall', 'update']], parallelGroups: [], replans: [], nodes: [...perfect.submission.plan.nodes.map((node) => node.stepId === 'verify' ? { stepId: 'verify', status: 'pending' as const } : node), { stepId: 'extra', status: 'completed', evidenceRef: 'extra' }] } },
    })
    expect(metrics).toMatchObject({ prerequisite_edge_precision: 1, prerequisite_edge_recall: 1 / 6, parallel_branch_recall: 0, replan_compliance: 0, verified_completion_rate: 5 / 6, plan_bloat_ratio: 1 / 6, plan_converged: false })
    expect(metrics.blocked_task_violation_rate).toBeGreaterThan(0)
  })

  it('derives execution order only from native command/tool events', () => {
    const events = [
      { method: 'item/started', params: { item: { id: '1', type: 'commandExecution', command: 'node scripts/run-step.mjs recall' } } },
      { method: 'item/completed', params: { item: { id: '1', type: 'commandExecution', command: 'node scripts/run-step.mjs recall', output: 'done' } } },
      { type: 'tool_call', id: '2', arguments: { cmd: 'node scripts/run-step.mjs update && node scripts/run-step.mjs test' } },
      { type: 'agentMessage', text: 'node scripts/run-step.mjs verify' },
    ]
    expect(deriveObservedExecutionOrder(events, perfect.oracle.expectedPlanNodes)).toEqual(['recall', 'update', 'test'])
  })

  it('strictly rejects expanded, duplicate, and malformed observation schemas', () => {
    for (const value of [
      'not-json', JSON.stringify({ ...perfect, extra: true }),
      JSON.stringify({ ...perfect, observedExecutionOrder: ['recall', 'recall'] }),
      JSON.stringify({ ...perfect, submission: { ...perfect.submission, memoryAnswers: [{ factId: 'owner', value: 'a' }, { factId: 'owner', value: 'b' }] } }),
      JSON.stringify({ ...perfect, submission: { ...perfect.submission, plan: { ...perfect.submission.plan, nodes: [{ stepId: 'x', status: 'claimed' }] } } }),
    ]) expect(parseMemoryPlanningObservation(value)).toBeNull()
  })

  it('keeps rate metrics bounded for generated fact subsets and topological orders', () => {
    fc.assert(fc.property(fc.subarray([...perfect.submission.memoryAnswers]), fc.boolean(), (answers, reverse) => {
      const observation = { ...perfect, submission: { ...perfect.submission, memoryAnswers: answers }, observedExecutionOrder: reverse ? [...perfect.observedExecutionOrder].reverse() : perfect.observedExecutionOrder }
      const metrics = deriveMemoryPlanningMetrics(observation)
      for (const [name, value] of Object.entries(metrics)) if (typeof value === 'number' && name !== 'plan_bloat_ratio') { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1) }
      if (!reverse) expect(metrics.blocked_task_violation_rate).toBe(0)
    }), { numRuns: 300 })
  })
})
