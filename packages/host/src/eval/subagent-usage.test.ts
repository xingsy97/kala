import { describe, expect, it } from 'vitest'

import {
  createEvalExperiment,
  summarizeEvalRun,
  summarizeSubAgentUsage,
  type EvalTrial,
} from '@agent-kernel/shared/enhancement'

describe('summarizeSubAgentUsage', () => {
  it('returns zeros when the graph has no matching parents', () => {
    const trials: EvalTrial[] = [
      {
        trialId: 't1',
        experimentId: 'e',
        instanceId: 'inst-1',
        sessionId: 'session-1',
        status: 'completed',
        resolved: true,
        artifacts: [],
        metrics: {},
      },
    ]
    const usage = summarizeSubAgentUsage(trials, { nodes: [], edges: [] })
    expect(usage.totalCount).toBe(0)
    expect(usage.trialsWithSubagents).toBe(0)
    expect(usage.maxDepth).toBe(0)
    expect(usage.perTrialMean).toBe(0)
  })

  it('counts direct child sub-agents and marks the trial as using subagents', () => {
    const trials: EvalTrial[] = [
      {
        trialId: 't1',
        experimentId: 'e',
        instanceId: 'inst-1',
        sessionId: 'session-1',
        status: 'completed',
        resolved: true,
        artifacts: [],
        metrics: {},
      },
    ]
    const usage = summarizeSubAgentUsage(trials, {
      nodes: [
        { sessionId: 'session-1' },
        { sessionId: 'child-a', parentSessionId: 'session-1' },
        { sessionId: 'child-b', parentSessionId: 'session-1' },
      ],
      edges: [
        { parentSessionId: 'session-1', childSessionId: 'child-a' },
        { parentSessionId: 'session-1', childSessionId: 'child-b' },
      ],
    })
    expect(usage.totalCount).toBe(2)
    expect(usage.trialsWithSubagents).toBe(1)
    expect(usage.maxDepth).toBe(1)
    expect(usage.perTrialMean).toBe(2)
    expect(usage.resolvedWithSubagents).toBe(1)
    expect(usage.unresolvedWithSubagents).toBe(0)
  })

  it('walks nested children to compute max depth', () => {
    const trials: EvalTrial[] = [
      {
        trialId: 't1',
        experimentId: 'e',
        instanceId: 'inst-1',
        sessionId: 'session-1',
        status: 'completed',
        resolved: false,
        artifacts: [],
        metrics: {},
      },
    ]
    const usage = summarizeSubAgentUsage(trials, {
      nodes: [],
      edges: [
        { parentSessionId: 'session-1', childSessionId: 'child-a' },
        { parentSessionId: 'child-a', childSessionId: 'grandchild' },
        { parentSessionId: 'grandchild', childSessionId: 'great-grandchild' },
      ],
    })
    expect(usage.totalCount).toBe(3)
    expect(usage.maxDepth).toBe(3)
    expect(usage.resolvedWithSubagents).toBe(0)
    expect(usage.unresolvedWithSubagents).toBe(1)
  })

  it('handles cyclic edges without recursing forever', () => {
    const trials: EvalTrial[] = [
      {
        trialId: 't1',
        experimentId: 'e',
        instanceId: 'inst-1',
        sessionId: 'session-1',
        status: 'completed',
        resolved: true,
        artifacts: [],
        metrics: {},
      },
    ]
    const usage = summarizeSubAgentUsage(trials, {
      nodes: [],
      edges: [
        { parentSessionId: 'session-1', childSessionId: 'child-a' },
        { parentSessionId: 'child-a', childSessionId: 'session-1' },
      ],
    })
    expect(usage.totalCount).toBe(1)
    expect(usage.maxDepth).toBe(1)
  })

  it('averages across multiple trials', () => {
    const trials: EvalTrial[] = [
      {
        trialId: 't1',
        experimentId: 'e',
        instanceId: 'inst-1',
        sessionId: 'session-1',
        status: 'completed',
        resolved: true,
        artifacts: [],
        metrics: {},
      },
      {
        trialId: 't2',
        experimentId: 'e',
        instanceId: 'inst-2',
        sessionId: 'session-2',
        status: 'completed',
        resolved: false,
        artifacts: [],
        metrics: {},
      },
      {
        trialId: 't3',
        experimentId: 'e',
        instanceId: 'inst-3',
        // no sessionId  -  ignored
        status: 'completed',
        resolved: true,
        artifacts: [],
        metrics: {},
      },
    ]
    const usage = summarizeSubAgentUsage(trials, {
      nodes: [],
      edges: [
        { parentSessionId: 'session-1', childSessionId: 'a' },
        { parentSessionId: 'session-1', childSessionId: 'b' },
        { parentSessionId: 'session-2', childSessionId: 'c' },
      ],
    })
    expect(usage.totalCount).toBe(3)
    expect(usage.trialsWithSubagents).toBe(2)
    expect(usage.perTrialMean).toBeCloseTo(1, 5)
  })
})

describe('summarizeEvalRun with subAgentGraph', () => {
  it('attaches subagentUsage when a graph is passed', () => {
    const experiment = createEvalExperiment({
      dataset: 'demo',
      model: 'test-model',
      experimentId: 'exp-1',
      createdAt: '2026-07-09T00:00:00.000Z',
    })
    const trials: EvalTrial[] = [
      {
        trialId: 't1',
        experimentId: 'exp-1',
        instanceId: 'inst-1',
        sessionId: 'session-1',
        status: 'completed',
        resolved: true,
        artifacts: [],
        metrics: {},
      },
    ]
    const summary = summarizeEvalRun(experiment, trials, {
      subAgentGraph: {
        nodes: [],
        edges: [{ parentSessionId: 'session-1', childSessionId: 'child-a' }],
      },
    })
    expect(summary.subagentUsage).toBeDefined()
    expect(summary.subagentUsage?.totalCount).toBe(1)
    expect(summary.subagentUsage?.trialsWithSubagents).toBe(1)
  })

  it('omits subagentUsage when no graph is passed', () => {
    const experiment = createEvalExperiment({
      dataset: 'demo',
      model: 'test-model',
      experimentId: 'exp-1',
      createdAt: '2026-07-09T00:00:00.000Z',
    })
    const summary = summarizeEvalRun(experiment, [])
    expect(summary.subagentUsage).toBeUndefined()
  })
})
