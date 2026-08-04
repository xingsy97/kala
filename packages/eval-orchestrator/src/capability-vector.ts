import { CAPABILITY_VECTOR_COMPONENTS, CapabilityVectorSchema, type CapabilityVector, type DefectFinding, type TrialEvidence } from '@agent-kernel/eval-protocol'

type ComponentName = typeof CAPABILITY_VECTOR_COMPONENTS[number]
type ComponentInput = { score: number; detectorIds?: readonly string[]; verifierIds?: readonly string[]; evidenceRefs: readonly string[] }

export const CAPABILITY_METHODOLOGY_VERSION = '1.0.0'

export function deriveCapabilityVector(input: {
  runId: string; agentVariantId: string; methodologyVersion: string; trials: readonly TrialEvidence[]; findings?: readonly DefectFinding[]
}): CapabilityVector {
  if (input.trials.length === 0) throw new Error('capability vector requires immutable trial evidence')
  const findings = (input.findings ?? []).filter((finding) => input.trials.some((trial) => trial.trialId === finding.trialId))
  const evidenceRefs = input.trials.map((trial) => trial.resultHash)
  const verifierIds = [...new Set(input.trials.map((trial) => trial.benchmarkResult.verifierId))].sort()
  const native = (names: readonly string[]) => metricScore(input.trials, names)
  const noFinding = (category: DefectFinding['category']) => 1 - ratio(findings.filter((finding) => finding.category === category).length, input.trials.length)
  const components: Record<ComponentName, ComponentInput> = {
    taskSuccess: { score: passRate(input.trials), verifierIds, evidenceRefs },
    codeUnderstanding: { score: native(['file_recall_at_k', 'localization_recall', 'dependency_chain_accuracy', 'repository_understanding']), verifierIds, evidenceRefs },
    instructionFollowing: { score: noFinding('instruction_drift'), detectorIds: ['instruction-drift'], evidenceRefs },
    toolGrounding: { score: native(['recovery_action_grounded', 'tool_grounding', 'tool_schema_valid_rate']), detectorIds: ['tool-recovery'], verifierIds, evidenceRefs },
    recovery: { score: native(['recovered', 'service_recovered', 'rollback_verified', 'recovery_rate']), detectorIds: ['tool-recovery'], verifierIds, evidenceRefs },
    contextRetention: { score: average([native(['compaction_retention', 'long_term_recall']), noFinding('context_forgetting')]), detectorIds: ['context-forgetting'], verifierIds, evidenceRefs },
    memoryQuality: { score: native(['memory_recall', 'memory_precision', 'correction_compliance', 'deletion_compliance', 'cross_workspace_isolation']), detectorIds: ['context-forgetting'], verifierIds, evidenceRefs },
    planning: { score: native(['plan_execution_alignment', 'replan_compliance', 'verified_completion_rate', 'prerequisite_edge_precision', 'prerequisite_edge_recall']), detectorIds: ['planning-execution'], verifierIds, evidenceRefs },
    testIntegrity: { score: average([native(['protected_integrity_passed', 'hidden_verifier_passed', 'verifier_protocol_valid']), noFinding('test_gaming')]), detectorIds: ['test-gaming'], verifierIds, evidenceRefs },
    efficiency: { score: efficiencyScore(input.trials), verifierIds, evidenceRefs },
    reproducibility: { score: reproducibilityScore(input.trials), verifierIds, evidenceRefs },
  }
  return CapabilityVectorSchema.parse({
    schemaVersion: 1, methodologyVersion: input.methodologyVersion, runId: input.runId, agentVariantId: input.agentVariantId,
    components: Object.fromEntries(CAPABILITY_VECTOR_COMPONENTS.map((name) => [name, { ...components[name], detectorIds: components[name].detectorIds ?? [], verifierIds: components[name].verifierIds ?? [], methodologyRef: 'methodology://' + input.methodologyVersion + '/capability/' + name }])),
  })
}

function passRate(trials: readonly TrialEvidence[]): number { return average(trials.map((trial) => Number(Object.values(trial.benchmarkResult.nativeMetrics).some((value) => value === true || typeof value === 'number' && value > 0 || typeof value === 'string' && /^(?:pass|passed|success|resolved)$/iu.test(value))))) }
function metricScore(trials: readonly TrialEvidence[], names: readonly string[]): number {
  const values = trials.flatMap((trial) => names.flatMap((name) => normalizedMetric(trial.benchmarkResult.nativeMetrics[name])))
  return values.length > 0 ? average(values) : passRate(trials)
}
function normalizedMetric(value: unknown): number[] { return typeof value === 'boolean' ? [Number(value)] : typeof value === 'number' && Number.isFinite(value) ? [Math.max(0, Math.min(1, value))] : [] }
function efficiencyScore(trials: readonly TrialEvidence[]): number {
  const available = trials.filter((trial) => trial.usage.availability === 'available')
  if (available.length === 0) return passRate(trials)
  const tokens = available.map((trial) => trial.usage.availability === 'available' ? trial.usage.inputTokens + trial.usage.outputTokens : 0)
  const scale = Math.max(...tokens, 1)
  return average(tokens.map((value) => 1 - value / (scale * 2)))
}
function reproducibilityScore(trials: readonly TrialEvidence[]): number {
  const locks = new Set(trials.map((trial) => JSON.stringify(trial.environmentLock)))
  const coordinates = new Set(trials.map((trial) => [trial.taskId, trial.repeatIndex].join('|')))
  return average([Number(locks.size >= 1), Number(coordinates.size === trials.length), Number(trials.every((trial) => trial.artifactManifest.manifestHash.length === 64))])
}
function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length }
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : numerator / denominator }
