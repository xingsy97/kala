import { BenchmarkDescriptorSchema } from '@agent-kernel/eval-protocol'
import { createDeclarativeBenchmarkPlugin } from '@agent-kernel/eval-benchmark-common'
import type { VerificationStepResult } from '@agent-kernel/eval-benchmark-common'
import type { VerificationInput } from '@agent-kernel/eval-sdk'

export const CODE_UNDERSTANDING_METRIC_NAMES = [
  'file_recall_at_k',
  'symbol_recall_at_k',
  'first_relevant_read_rank',
  'irrelevant_read_ratio',
  'dependency_edge_precision',
  'dependency_edge_recall',
] as const

export type DependencyEdge = readonly [source: string, target: string]
export type CodeUnderstandingObservation = {
  k: number
  rankedFiles: readonly string[]
  rankedSymbols: readonly string[]
  readSequence: readonly string[]
  predictedDependencyEdges: readonly DependencyEdge[]
  oracle: {
    repositoryFiles: readonly string[]
    relevantFiles: readonly string[]
    relevantSymbols: readonly string[]
    dependencyEdges: readonly DependencyEdge[]
  }
}

const policy = {
  descriptor: BenchmarkDescriptorSchema.parse({
    schemaVersion: 1,
    id: 'code-understanding',
    label: 'Code Understanding',
    version: '1.0.0',
    official: false,
    nativePrimaryMetric: 'file_recall_at_k',
    verifierId: 'code-understanding-native',
    verifierVersion: '1.0.0',
  }),
  taskPackId: 'code-understanding',
  failureCode: 'CODE_UNDERSTANDING_FAILED',
  failureSummary: 'Declared localization and dependency metrics did not meet the task verifier',
  deriveMetrics: codeUnderstandingMetrics,
}

export const evaluationPlugins = [createDeclarativeBenchmarkPlugin(policy)] as const
export const createCodeUnderstandingAdapter = evaluationPlugins[0].create

export function codeUnderstandingMetrics(steps: readonly VerificationStepResult[], input?: VerificationInput): Record<string, number | boolean> {
  const step = steps.find((candidate) => candidate.nativeMetric === 'code_understanding_observation')
  const fallback = {
    file_recall_at_k: 0, symbol_recall_at_k: 0, first_relevant_read_rank: 0, irrelevant_read_ratio: 1,
    dependency_edge_precision: 0, dependency_edge_recall: 0, verifier_protocol_valid: false,
    passedSteps: steps.filter((candidate) => candidate.passed).length, totalSteps: steps.length,
  }
  if (!step?.passed || typeof step.emittedMetrics.code_understanding_observation !== 'string') return fallback

  const observation = parseCodeUnderstandingObservation(step.emittedMetrics.code_understanding_observation)
  if (!observation) return fallback
  const traceReadSequence = input ? deriveTraceReadSequence(input.agentArtifacts.nativeEvents, observation.oracle.repositoryFiles) : observation.readSequence
  return {
    ...deriveCodeUnderstandingMetrics({ ...observation, readSequence: traceReadSequence }),
    verifier_protocol_valid: true,
    passedSteps: steps.filter((candidate) => candidate.passed).length,
    totalSteps: steps.length,
  }
}

export function deriveCodeUnderstandingMetrics(observation: CodeUnderstandingObservation): Record<(typeof CODE_UNDERSTANDING_METRIC_NAMES)[number], number> {
  const relevantFiles = new Set(observation.oracle.relevantFiles)
  const relevantSymbols = new Set(observation.oracle.relevantSymbols)
  const expectedEdges = new Set(observation.oracle.dependencyEdges.map(edgeKey))
  const predictedEdges = new Set(observation.predictedDependencyEdges.map(edgeKey))
  const topFiles = new Set(observation.rankedFiles.slice(0, observation.k))
  const topSymbols = new Set(observation.rankedSymbols.slice(0, observation.k))
  const firstRelevantRead = observation.readSequence.findIndex((path) => relevantFiles.has(path))
  const irrelevantReads = observation.readSequence.filter((path) => !relevantFiles.has(path)).length
  let truePositiveEdges = 0
  for (const edge of predictedEdges) if (expectedEdges.has(edge)) truePositiveEdges += 1

  return {
    file_recall_at_k: intersectionSize(topFiles, relevantFiles) / relevantFiles.size,
    symbol_recall_at_k: intersectionSize(topSymbols, relevantSymbols) / relevantSymbols.size,
    first_relevant_read_rank: firstRelevantRead < 0 ? 0 : firstRelevantRead + 1,
    irrelevant_read_ratio: observation.readSequence.length === 0 ? 1 : irrelevantReads / observation.readSequence.length,
    dependency_edge_precision: predictedEdges.size === 0 ? Number(expectedEdges.size === 0) : truePositiveEdges / predictedEdges.size,
    dependency_edge_recall: expectedEdges.size === 0 ? 1 : truePositiveEdges / expectedEdges.size,
  }
}

export function parseCodeUnderstandingObservation(serialized: string): CodeUnderstandingObservation | null {
  try {
    const value = JSON.parse(serialized) as unknown
    if (!isRecord(value) || !hasExactKeys(value, ['k', 'oracle', 'predictedDependencyEdges', 'rankedFiles', 'rankedSymbols', 'readSequence'])) return null
    if (!Number.isInteger(value.k) || (value.k as number) <= 0) return null
    if (!isUniqueStringArray(value.rankedFiles) || !isUniqueStringArray(value.rankedSymbols) || !isStringArray(value.readSequence)) return null
    if (!isEdgeArray(value.predictedDependencyEdges, true)) return null
    if (!isRecord(value.oracle) || !hasExactKeys(value.oracle, ['dependencyEdges', 'relevantFiles', 'relevantSymbols', 'repositoryFiles'])) return null
    if (!isUniqueNonEmptyStringArray(value.oracle.repositoryFiles) || !isUniqueNonEmptyStringArray(value.oracle.relevantFiles) || !isUniqueNonEmptyStringArray(value.oracle.relevantSymbols)) return null
    if (!(value.oracle.relevantFiles as string[]).every((path) => (value.oracle as Record<string, unknown>).repositoryFiles instanceof Array && ((value.oracle as Record<string, unknown>).repositoryFiles as string[]).includes(path))) return null
    if (!isEdgeArray(value.oracle.dependencyEdges, true)) return null
    return value as CodeUnderstandingObservation
  } catch {
    return null
  }
}

export function deriveTraceReadSequence(nativeEvents: readonly unknown[], repositoryFiles: readonly string[]): string[] {
  const groups = new Map<string, { order: number; payloads: string[] }>()
  nativeEvents.forEach((event, order) => {
    if (!isRecord(event)) return
    const params = isRecord(event.params) ? event.params : {}
    const item = isRecord(params.item) ? params.item : event
    const kind = [event.method, event.type, item.type].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase()
    if (!/(?:command|tool|shell)/u.test(kind)) return
    const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : 'event-' + String(order)
    const group = groups.get(id) ?? { order, payloads: [] }
    collectStrings(item, group.payloads)
    groups.set(id, group)
  })

  const sequence: string[] = []
  for (const group of [...groups.values()].sort((left, right) => left.order - right.order)) {
    const payload = group.payloads.join('\n')
    const matches = repositoryFiles
      .map((path) => ({ path, index: payload.indexOf(path) }))
      .filter((match) => match.index >= 0)
      .sort((left, right) => left.index - right.index || left.path.localeCompare(right.path))
    sequence.push(...matches.map((match) => match.path))
  }
  return sequence
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0
  for (const value of left) if (right.has(value)) count += 1
  return count
}
function edgeKey([source, target]: DependencyEdge): string { return JSON.stringify([source, target]) }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 500)
}
function isUniqueStringArray(value: unknown): value is string[] { return isStringArray(value) && new Set(value).size === value.length }
function isUniqueNonEmptyStringArray(value: unknown): value is string[] { return isUniqueStringArray(value) && value.length > 0 }
function isEdgeArray(value: unknown, unique: boolean): value is DependencyEdge[] {
  if (!Array.isArray(value) || !value.every((edge) => Array.isArray(edge) && edge.length === 2 && edge.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 500))) return false
  return !unique || new Set(value.map((edge) => edgeKey(edge as DependencyEdge))).size === value.length
}
function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') { output.push(value); return }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, output); return }
  if (isRecord(value)) for (const item of Object.values(value)) collectStrings(item, output)
}
