/**
 * Evaluation types shared across the eval platform, SWE-bench adapter, and
 * dashboard. The vocabulary of failure labels is intentionally
 * low-cardinality (see enhancement doc  - 5): raw details stay in artifacts.
 */

import { randomUUID } from 'node:crypto'

import type { ArtifactRef } from './artifact-store.js'

export type EvalFailureLabel =
  | 'resolved'
  | 'agent_timeout'
  | 'agent_error'
  | 'empty_patch'
  | 'patch_apply_failed'
  | 'test_failed'
  | 'harness_error'
  | 'infrastructure_error'

export type EvalScoreResult = {
  scorer: string
  passed: boolean
  label?: EvalFailureLabel
  score: number
  metrics: Record<string, number | string | boolean>
  artifactRefs: readonly ArtifactRef[]
  explanation?: string
}

export type ModelJudgeTraceArtifact = {
  schemaVersion: 1
  scorer: string
  judgeModel: string
  inputRef?: string
  prompt: string
  response: unknown
  parsed: {
    score: number
    passed: boolean
    label?: EvalFailureLabel
    explanation?: string
  }
  metadata: Record<string, unknown>
}

export function createModelJudgeTraceArtifact(input: {
  scorer: string
  judgeModel: string
  inputRef?: string
  prompt: string
  response: unknown
  score: number
  threshold?: number
  label?: EvalFailureLabel
  explanation?: string
  metadata?: Record<string, unknown>
}): ModelJudgeTraceArtifact {
  const threshold = boundedUnitValue(input.threshold ?? 0.5, 'judge threshold')
  const score = boundedUnitValue(input.score, 'judge score')
  return {
    schemaVersion: 1,
    scorer: input.scorer,
    judgeModel: input.judgeModel,
    ...(input.inputRef ? { inputRef: input.inputRef } : {}),
    prompt: input.prompt,
    response: input.response,
    parsed: {
      score,
      passed: score >= threshold,
      ...(input.label ? { label: input.label } : {}),
      ...(input.explanation ? { explanation: input.explanation } : {}),
    },
    metadata: {
      threshold,
      ...(input.metadata ?? {}),
    },
  }
}

function boundedUnitValue(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a number between 0 and 1`)
  return value
}

export type EvalScoreSummary = {
  instanceId?: string
  resolved: boolean
  failureLabel: EvalFailureLabel
  score: number
  results: readonly EvalScoreResult[]
}

export type EvalMemoryPolicy = {
  mode: 'disabled' | 'workspace_only' | 'workspace_and_global' | 'snapshot_pinned'
  includeGlobal: boolean
  snapshotRef?: string
  workspaceRoot?: string
  entryCount?: number
  tombstoneCount?: number
  generatedAt?: string
  reasonCodes: readonly string[]
}

export type EvalMemoryPolicyInput = {
  mode?: EvalMemoryPolicy['mode']
  includeGlobal?: boolean
  snapshotRef?: string
  workspaceRoot?: string
  memoryIndex?: {
    generatedAt?: string
    entries?: readonly { status?: string }[]
  }
  benchmarkIsolation?: boolean
}

export function deriveEvalMemoryPolicy(input: EvalMemoryPolicyInput = {}): EvalMemoryPolicy {
  const includeGlobal = input.includeGlobal ?? false
  const explicit = input.mode
  const mode: EvalMemoryPolicy['mode'] = explicit
    ?? (input.benchmarkIsolation
      ? 'disabled'
      : input.snapshotRef
        ? 'snapshot_pinned'
        : includeGlobal
          ? 'workspace_and_global'
          : 'workspace_only')
  const reasonCodes: string[] = [`memory_mode:${mode}`]
  if (input.benchmarkIsolation) reasonCodes.push('benchmark_isolation')
  if (mode === 'disabled') reasonCodes.push('memory_disabled')
  if (includeGlobal) reasonCodes.push('global_included')
  if (input.snapshotRef) reasonCodes.push('snapshot_pinned')

  const entries = input.memoryIndex?.entries ?? []
  const active = entries.filter((entry) => (entry.status ?? 'active') === 'active').length
  const tombstoned = entries.filter((entry) => entry.status === 'tombstoned').length

  return {
    mode,
    includeGlobal,
    ...(input.snapshotRef ? { snapshotRef: input.snapshotRef } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.memoryIndex ? { entryCount: active, tombstoneCount: tombstoned } : {}),
    ...(input.memoryIndex?.generatedAt ? { generatedAt: input.memoryIndex.generatedAt } : {}),
    reasonCodes,
  }
}

export type EvalExperiment = {
  experimentId: string
  createdAt: string
  dataset: string
  split?: string
  model: string
  config: Record<string, unknown>
  memoryPolicy?: EvalMemoryPolicy
}

export type EvalTrial = {
  trialId: string
  experimentId: string
  instanceId: string
  sessionId?: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timed_out'
  resolved?: boolean
  failureLabel?: EvalFailureLabel
  artifacts: readonly ArtifactRef[]
  metrics: Record<string, number | string | boolean>
}

export type EvalRunSummary = {
  experimentId: string
  dataset: string
  split?: string
  model: string
  trialCount: number
  completed: number
  failed: number
  timedOut: number
  resolved: number
  unresolved: number
  emptyPatch: number
  failureCounts: Record<string, number>
  metrics: Record<string, number | string | boolean>
  subagentUsage?: EvalSubAgentUsage
}

export type EvalSubAgentUsage = {
  totalCount: number
  trialsWithSubagents: number
  maxDepth: number
  perTrialMean: number
  resolvedWithSubagents: number
  unresolvedWithSubagents: number
  countByRole?: Record<string, number>
}

export type EvalSubAgentGraphInput = {
  nodes: ReadonlyArray<{ sessionId: string; parentSessionId?: string }>
  edges: ReadonlyArray<{ parentSessionId: string; childSessionId: string }>
}

export function summarizeSubAgentUsage(
  trials: readonly EvalTrial[],
  graph: EvalSubAgentGraphInput,
): EvalSubAgentUsage {
  const parentToChildren = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = parentToChildren.get(edge.parentSessionId) ?? []
    list.push(edge.childSessionId)
    parentToChildren.set(edge.parentSessionId, list)
  }

  let totalCount = 0
  let trialsWithSubagents = 0
  let maxDepth = 0
  let resolvedWithSubagents = 0
  let unresolvedWithSubagents = 0
  for (const trial of trials) {
    if (!trial.sessionId) continue
    const { count, depth } = walkSubTree(trial.sessionId, parentToChildren)
    if (count === 0) continue
    totalCount += count
    trialsWithSubagents += 1
    if (depth > maxDepth) maxDepth = depth
    if (trial.resolved === true) resolvedWithSubagents += 1
    if (trial.resolved === false) unresolvedWithSubagents += 1
  }

  const denom = trials.length > 0 ? trials.length : 1
  return {
    totalCount,
    trialsWithSubagents,
    maxDepth,
    perTrialMean: totalCount / denom,
    resolvedWithSubagents,
    unresolvedWithSubagents,
  }
}

function walkSubTree(
  root: string,
  parentToChildren: ReadonlyMap<string, readonly string[]>,
): { count: number; depth: number } {
  let count = 0
  let depth = 0
  const stack: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }]
  const seen = new Set<string>([root])
  while (stack.length > 0) {
    const { id, depth: d } = stack.pop()!
    const children = parentToChildren.get(id) ?? []
    for (const child of children) {
      if (seen.has(child)) continue
      seen.add(child)
      count += 1
      const nextDepth = d + 1
      if (nextDepth > depth) depth = nextDepth
      stack.push({ id: child, depth: nextDepth })
    }
  }
  return { count, depth }
}

export type EvalSubAgentUsageDelta = {
  baseline: EvalSubAgentUsage | null
  candidate: EvalSubAgentUsage | null
  totalCount: number
  trialsWithSubagents: number
  maxDepth: number
  perTrialMean: number
  resolvedWithSubagents: number
  unresolvedWithSubagents: number
}

export function diffSubAgentUsage(
  baseline: EvalSubAgentUsage | undefined,
  candidate: EvalSubAgentUsage | undefined,
): EvalSubAgentUsageDelta | undefined {
  if (!baseline && !candidate) return undefined
  const zero: EvalSubAgentUsage = {
    totalCount: 0,
    trialsWithSubagents: 0,
    maxDepth: 0,
    perTrialMean: 0,
    resolvedWithSubagents: 0,
    unresolvedWithSubagents: 0,
  }
  const a = baseline ?? zero
  const b = candidate ?? zero
  return {
    baseline: baseline ?? null,
    candidate: candidate ?? null,
    totalCount: b.totalCount - a.totalCount,
    trialsWithSubagents: b.trialsWithSubagents - a.trialsWithSubagents,
    maxDepth: b.maxDepth - a.maxDepth,
    perTrialMean: b.perTrialMean - a.perTrialMean,
    resolvedWithSubagents: b.resolvedWithSubagents - a.resolvedWithSubagents,
    unresolvedWithSubagents: b.unresolvedWithSubagents - a.unresolvedWithSubagents,
  }
}

export function createEvalExperiment(input: {
  dataset: string
  split?: string
  model: string
  config?: Record<string, unknown>
  experimentId?: string
  createdAt?: string
  memoryPolicy?: EvalMemoryPolicy
}): EvalExperiment {
  return {
    experimentId: input.experimentId ?? `eval_${randomUUID()}`,
    createdAt: input.createdAt ?? new Date().toISOString(),
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    config: input.config ?? {},
    ...(input.memoryPolicy ? { memoryPolicy: input.memoryPolicy } : {}),
  }
}

export function summarizeEvalRun(
  experiment: EvalExperiment,
  trials: readonly EvalTrial[],
  options: { subAgentGraph?: EvalSubAgentGraphInput } = {},
): EvalRunSummary {
  const failureCounts: Record<string, number> = {}
  let completed = 0
  let failed = 0
  let timedOut = 0
  let resolved = 0
  let emptyPatch = 0
  for (const trial of trials) {
    if (trial.status === 'completed') completed += 1
    if (trial.status === 'failed') failed += 1
    if (trial.status === 'timed_out') timedOut += 1
    if (trial.resolved === true) resolved += 1
    if (trial.failureLabel) {
      failureCounts[trial.failureLabel] = (failureCounts[trial.failureLabel] ?? 0) + 1
      if (trial.failureLabel === 'empty_patch') emptyPatch += 1
    }
  }
  const unresolved = trials.filter((trial) => trial.resolved === false).length
  const subagentUsage = options.subAgentGraph
    ? summarizeSubAgentUsage(trials, options.subAgentGraph)
    : undefined
  return {
    experimentId: experiment.experimentId,
    dataset: experiment.dataset,
    ...(experiment.split ? { split: experiment.split } : {}),
    model: experiment.model,
    trialCount: trials.length,
    completed,
    failed,
    timedOut,
    resolved,
    unresolved,
    emptyPatch,
    failureCounts,
    metrics: {
      passRate: trials.length > 0 ? resolved / trials.length : 0,
    },
    ...(subagentUsage ? { subagentUsage } : {}),
  }
}

export function summarizeEvalScores(
  results: readonly EvalScoreResult[],
  instanceId?: string,
): EvalScoreSummary {
  const failed = results.find((result) => !result.passed)
  const resolved = !failed && results.length > 0
  const failureLabel = resolved ? 'resolved' : failed?.label ?? 'agent_error'
  return {
    ...(instanceId ? { instanceId } : {}),
    resolved,
    failureLabel,
    score: resolved ? 1 : 0,
    results,
  }
}

export function serializeJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '')
}
