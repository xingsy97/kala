import { BenchmarkDescriptorSchema } from '@agent-kernel/eval-protocol'
import { createDeclarativeBenchmarkPlugin } from '@agent-kernel/eval-benchmark-common'
import type { VerificationStepResult } from '@agent-kernel/eval-benchmark-common'
import type { VerificationInput } from '@agent-kernel/eval-sdk'

type Edge = readonly [source: string, target: string]
type Fact = { factId: string; value: string }
type Replan = { triggerId: string; supersededStepId: string; replacementStepId: string }
type PlanNode = { stepId: string; status: 'pending' | 'completed'; evidenceRef?: string }

export type MemoryPlanningObservation = {
  submission: {
    memoryAnswers: readonly Fact[]
    plan: { nodes: readonly PlanNode[]; dependencyEdges: readonly Edge[]; parallelGroups: readonly (readonly string[])[]; replans: readonly Replan[] }
  }
  oracle: {
    activeFacts: readonly Fact[]
    correctedFactIds: readonly string[]
    preCompactionFactIds: readonly string[]
    longTermFactIds: readonly string[]
    staleValues: readonly string[]
    deletedValues: readonly string[]
    foreignValues: readonly string[]
    expectedPlanNodes: readonly string[]
    expectedDependencyEdges: readonly Edge[]
    expectedParallelPairs: readonly Edge[]
    expectedReplans: readonly Replan[]
  }
  observedExecutionOrder: readonly string[]
}

const policy = {
  descriptor: BenchmarkDescriptorSchema.parse({ schemaVersion: 1, id: 'memory-planning', label: 'Memory & Planning', version: '1.0.0', official: false, nativePrimaryMetric: 'memory_recall', verifierId: 'memory-planning-native', verifierVersion: '1.0.0' }),
  taskPackId: 'memory-planning', failureCode: 'MEMORY_PLANNING_FAILED', failureSummary: 'Memory retention or plan execution verifier failed', deriveMetrics: memoryPlanningMetrics,
}
export const evaluationPlugins = [createDeclarativeBenchmarkPlugin(policy)] as const
export const createMemoryPlanningAdapter = evaluationPlugins[0].create

export function memoryPlanningMetrics(steps: readonly VerificationStepResult[], input?: VerificationInput): Record<string, number | boolean> {
  const step = steps.find((candidate) => candidate.nativeMetric === 'memory_planning_observation')
  const fallback = emptyMetrics(steps)
  if (!step?.passed || typeof step.emittedMetrics.memory_planning_observation !== 'string') return fallback
  const observation = parseMemoryPlanningObservation(step.emittedMetrics.memory_planning_observation)
  if (!observation) return fallback
  const observedExecutionOrder = input ? deriveObservedExecutionOrder(input.agentArtifacts.nativeEvents, observation.oracle.expectedPlanNodes) : observation.observedExecutionOrder
  return { ...deriveMemoryPlanningMetrics({ ...observation, observedExecutionOrder }), verifier_protocol_valid: true, passedSteps: steps.filter((candidate) => candidate.passed).length, totalSteps: steps.length }
}

export function deriveMemoryPlanningMetrics(observation: MemoryPlanningObservation): Record<string, number | boolean> {
  const answers = new Map(observation.submission.memoryAnswers.map((fact) => [fact.factId, fact.value]))
  const activeFacts = new Map(observation.oracle.activeFacts.map((fact) => [fact.factId, fact.value]))
  const correctAnswers = [...activeFacts].filter(([factId, value]) => answers.get(factId) === value).length
  const answerValues = observation.submission.memoryAnswers.map((fact) => fact.value)
  const submittedText = canonicalText(observation.submission)
  const corrected = subsetRecall(observation.oracle.correctedFactIds, answers, activeFacts)
  const preCompaction = subsetRecall(observation.oracle.preCompactionFactIds, answers, activeFacts)
  const longTerm = subsetRecall(observation.oracle.longTermFactIds, answers, activeFacts)

  const predictedEdges = new Set(observation.submission.plan.dependencyEdges.map(edgeKey))
  const expectedEdges = new Set(observation.oracle.expectedDependencyEdges.map(edgeKey))
  const truePositiveEdges = intersectionSize(predictedEdges, expectedEdges)
  const predictedParallel = new Set(observation.submission.plan.parallelGroups.flatMap(groupPairs).map(edgeKey))
  const expectedParallel = new Set(observation.oracle.expectedParallelPairs.map(normalizedPair).map(edgeKey))
  const expectedNodes = new Set(observation.oracle.expectedPlanNodes)
  const observed = observation.observedExecutionOrder.filter((stepId) => expectedNodes.has(stepId))
  const observedUnique = new Set(observed)
  const submittedNodes = new Set(observation.submission.plan.nodes.map((node) => node.stepId))
  const completedWithEvidence = new Set(observation.submission.plan.nodes.filter((node) => node.status === 'completed' && node.evidenceRef && observedUnique.has(node.stepId)).map((node) => node.stepId))
  const blockedViolations = blockedStarts(observation.observedExecutionOrder, observation.oracle.expectedDependencyEdges)
  const expectedReplans = new Set(observation.oracle.expectedReplans.map(replanKey))
  const submittedReplans = new Set(observation.submission.plan.replans.map(replanKey))
  const matchingReplans = intersectionSize(expectedReplans, submittedReplans)
  const extraNodes = [...submittedNodes].filter((stepId) => !expectedNodes.has(stepId)).length
  const planAlignment = expectedNodes.size === 0 ? 1 : observedUnique.size / new Set([...expectedNodes, ...observation.observedExecutionOrder]).size
  const verifiedCompletion = expectedNodes.size === 0 ? 1 : intersectionSize(completedWithEvidence, expectedNodes) / expectedNodes.size
  const replanCompliance = expectedReplans.size === 0 ? 1 : matchingReplans / expectedReplans.size
  const blockedRate = observed.length === 0 ? Number(expectedNodes.size > 0) : blockedViolations / observed.length

  return {
    memory_recall: activeFacts.size === 0 ? 1 : correctAnswers / activeFacts.size,
    memory_precision: answers.size === 0 ? Number(activeFacts.size === 0) : correctAnswers / answers.size,
    stale_memory_use_rate: contaminationRate(answerValues, observation.oracle.staleValues),
    correction_compliance: corrected,
    deletion_compliance: Number(!containsAny(submittedText, observation.oracle.deletedValues)),
    cross_workspace_isolation: Number(!containsAny(submittedText, observation.oracle.foreignValues)),
    compaction_retention: preCompaction,
    long_term_recall: longTerm,
    prerequisite_edge_precision: predictedEdges.size === 0 ? Number(expectedEdges.size === 0) : truePositiveEdges / predictedEdges.size,
    prerequisite_edge_recall: expectedEdges.size === 0 ? 1 : truePositiveEdges / expectedEdges.size,
    parallel_branch_recall: expectedParallel.size === 0 ? 1 : intersectionSize(predictedParallel, expectedParallel) / expectedParallel.size,
    blocked_task_violation_rate: blockedRate,
    replan_compliance: replanCompliance,
    plan_execution_alignment: planAlignment,
    verified_completion_rate: verifiedCompletion,
    plan_bloat_ratio: expectedNodes.size === 0 ? Number(extraNodes > 0) : extraNodes / expectedNodes.size,
    plan_converged: observed.length === expectedNodes.size && observedUnique.size === expectedNodes.size && blockedViolations === 0 && replanCompliance === 1 && verifiedCompletion === 1,
  }
}

export function deriveObservedExecutionOrder(nativeEvents: readonly unknown[], expectedStepIds: readonly string[]): string[] {
  const commands = new Map<string, { order: number; text: string }>()
  nativeEvents.forEach((event, order) => {
    if (!isRecord(event)) return
    const params = isRecord(event.params) ? event.params : {}
    const item = isRecord(params.item) ? params.item : event
    const kind = [event.method, event.type, item.type].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase()
    if (!/(?:command|tool|shell)/u.test(kind)) return
    const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : 'event-' + String(order)
    const existing = commands.get(id)
    const values: string[] = []
    collectStrings(item, values)
    commands.set(id, { order: existing?.order ?? order, text: (existing?.text ?? '') + '\n' + values.join('\n') })
  })
  const output: string[] = []
  for (const command of [...commands.values()].sort((left, right) => left.order - right.order)) {
    const matches = expectedStepIds.map((stepId) => ({ stepId, index: command.text.indexOf('run-step.mjs ' + stepId) })).filter((match) => match.index >= 0).sort((left, right) => left.index - right.index)
    output.push(...matches.map((match) => match.stepId))
  }
  return output
}

export function parseMemoryPlanningObservation(serialized: string): MemoryPlanningObservation | null {
  try {
    const value = JSON.parse(serialized) as unknown
    if (!isRecord(value) || !exactKeys(value, ['observedExecutionOrder', 'oracle', 'submission']) || !isStringArray(value.observedExecutionOrder)) return null
    if (!isRecord(value.submission) || !exactKeys(value.submission, ['memoryAnswers', 'plan']) || !isFactArray(value.submission.memoryAnswers)) return null
    if (!isRecord(value.submission.plan) || !exactKeys(value.submission.plan, ['dependencyEdges', 'nodes', 'parallelGroups', 'replans'])) return null
    if (!isPlanNodeArray(value.submission.plan.nodes) || !isEdgeArray(value.submission.plan.dependencyEdges) || !isParallelGroups(value.submission.plan.parallelGroups) || !isReplanArray(value.submission.plan.replans)) return null
    if (!isRecord(value.oracle) || !exactKeys(value.oracle, ['activeFacts', 'correctedFactIds', 'deletedValues', 'expectedDependencyEdges', 'expectedParallelPairs', 'expectedPlanNodes', 'expectedReplans', 'foreignValues', 'longTermFactIds', 'preCompactionFactIds', 'staleValues'])) return null
    if (!isFactArray(value.oracle.activeFacts) || !isStringArray(value.oracle.correctedFactIds) || !isStringArray(value.oracle.deletedValues) || !isEdgeArray(value.oracle.expectedDependencyEdges) || !isEdgeArray(value.oracle.expectedParallelPairs) || !isStringArray(value.oracle.expectedPlanNodes) || !isReplanArray(value.oracle.expectedReplans) || !isStringArray(value.oracle.foreignValues) || !isStringArray(value.oracle.longTermFactIds) || !isStringArray(value.oracle.preCompactionFactIds) || !isStringArray(value.oracle.staleValues)) return null
    if (hasDuplicates(value.observedExecutionOrder) || hasDuplicates(value.oracle.expectedPlanNodes) || hasDuplicates(value.oracle.correctedFactIds) || hasDuplicates(value.oracle.preCompactionFactIds) || hasDuplicates(value.oracle.longTermFactIds)) return null
    return value as MemoryPlanningObservation
  } catch { return null }
}

function emptyMetrics(steps: readonly VerificationStepResult[]): Record<string, number | boolean> { return { memory_recall: 0, memory_precision: 0, stale_memory_use_rate: 1, correction_compliance: 0, deletion_compliance: 0, cross_workspace_isolation: 0, compaction_retention: 0, long_term_recall: 0, prerequisite_edge_precision: 0, prerequisite_edge_recall: 0, parallel_branch_recall: 0, blocked_task_violation_rate: 1, replan_compliance: 0, plan_execution_alignment: 0, verified_completion_rate: 0, plan_bloat_ratio: 1, plan_converged: false, verifier_protocol_valid: false, passedSteps: steps.filter((step) => step.passed).length, totalSteps: steps.length } }
function subsetRecall(ids: readonly string[], answers: ReadonlyMap<string, string>, activeFacts: ReadonlyMap<string, string>): number { return ids.length === 0 ? 1 : ids.filter((factId) => answers.get(factId) === activeFacts.get(factId) && activeFacts.has(factId)).length / ids.length }
function contaminationRate(values: readonly string[], forbidden: readonly string[]): number { return values.length === 0 ? 0 : values.filter((value) => forbidden.includes(value)).length / values.length }
function containsAny(text: string, values: readonly string[]): boolean { return values.some((value) => value.length > 0 && text.includes(value)) }
function canonicalText(value: unknown): string { return JSON.stringify(value) }
function edgeKey(edge: Edge): string { return JSON.stringify(edge) }
function normalizedPair([left, right]: Edge): Edge { return left < right ? [left, right] : [right, left] }
function groupPairs(group: readonly string[]): Edge[] { const pairs: Edge[] = []; for (let left = 0; left < group.length; left += 1) for (let right = left + 1; right < group.length; right += 1) pairs.push(normalizedPair([group[left]!, group[right]!])); return pairs }
function replanKey(value: Replan): string { return JSON.stringify([value.triggerId, value.supersededStepId, value.replacementStepId]) }
function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number { let count = 0; for (const value of left) if (right.has(value)) count += 1; return count }
function blockedStarts(order: readonly string[], edges: readonly Edge[]): number { const completed = new Set<string>(); let violations = 0; for (const stepId of order) { if (edges.some(([source, target]) => target === stepId && !completed.has(source))) violations += 1; completed.add(stepId) } return violations }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]) }
function isString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 500 }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString) }
function hasDuplicates(values: readonly string[]): boolean { return new Set(values).size !== values.length }
function isFactArray(value: unknown): value is Fact[] { return Array.isArray(value) && value.every((fact) => isRecord(fact) && exactKeys(fact, ['factId', 'value']) && isString(fact.factId) && isString(fact.value)) && new Set(value.map((fact) => fact.factId)).size === value.length }
function isEdgeArray(value: unknown): value is Edge[] { return Array.isArray(value) && value.every((edge) => Array.isArray(edge) && edge.length === 2 && edge.every(isString)) && new Set(value.map((edge) => edgeKey(edge as Edge))).size === value.length }
function isParallelGroups(value: unknown): value is string[][] { return Array.isArray(value) && value.every((group) => isStringArray(group) && group.length >= 2 && !hasDuplicates(group)) }
function isReplanArray(value: unknown): value is Replan[] { return Array.isArray(value) && value.every((item) => isRecord(item) && exactKeys(item, ['replacementStepId', 'supersededStepId', 'triggerId']) && isString(item.triggerId) && isString(item.supersededStepId) && isString(item.replacementStepId)) && new Set(value.map((item) => replanKey(item as Replan))).size === value.length }
function isPlanNodeArray(value: unknown): value is PlanNode[] { return Array.isArray(value) && value.every((node) => isRecord(node) && (exactKeys(node, ['status', 'stepId']) || exactKeys(node, ['evidenceRef', 'status', 'stepId'])) && isString(node.stepId) && (node.status === 'pending' || node.status === 'completed') && (node.evidenceRef === undefined || isString(node.evidenceRef))) && new Set(value.map((node) => node.stepId)).size === value.length }
function collectStrings(value: unknown, output: string[]): void { if (typeof value === 'string') { output.push(value); return } if (Array.isArray(value)) { for (const item of value) collectStrings(item, output); return } if (isRecord(value)) for (const item of Object.values(value)) collectStrings(item, output) }
