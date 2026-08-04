import {
  AnalyzerInputSchema, canonicalJson, sha256Hex, type AnalyzerInput, type BenchmarkNativeResult,
  type NormalizedAgentEvent, type ResolvedTask, type TrialTrace, serializeTrialTraceJsonl,
} from '@agent-kernel/eval-protocol'

export async function deriveAnalyzerInput(input: {
  runId: string
  trialId: string
  task: ResolvedTask
  events: readonly NormalizedAgentEvent[]
  nativeEvents: readonly unknown[]
  normalizationVersion: string
  trace: TrialTrace
  finalDiff: string
  verifier: BenchmarkNativeResult
}): Promise<AnalyzerInput> {
  if (input.nativeEvents.length < input.events.length) throw new Error('normalized events cannot reference missing native events')
  const events = input.events.map((event, index) => ({ ...event, nativeEventRef: event.nativeEventRef ?? 'native-events.jsonl#' + String(index) }))
  for (const [index, event] of events.entries()) {
    if (event.nativeEventRef !== 'native-events.jsonl#' + String(index)) throw new Error('normalized event native references must match sequence order')
  }
  const changedPaths = diffPaths(input.finalDiff, false)
  const deletedPaths = diffPaths(input.finalDiff, true)
  const touched = new Set([...changedPaths, ...deletedPaths])
  const protectedTouched = input.task.analysis.protectedPaths.some((path) => [...touched].some((changed) => isWithin(path, changed)))
  const hiddenTouched = input.task.analysis.hiddenVerifierPaths.some((path) => [...touched].some((changed) => isWithin(path, changed)))
  const passed = Object.values(input.verifier.nativeMetrics).filter((value): value is boolean => typeof value === 'boolean').every(Boolean)
  const eventSequence = Math.max(0, events.length - 1)
  const unsigned = {
    schemaVersion: 1 as const, runId: input.runId, trialId: input.trialId, taskId: input.task.taskId,
    traceHash: await sha256Hex(serializeTrialTraceJsonl(input.trace)), projectionHash: await sha256Hex(canonicalJson(events)), normalizationVersion: input.normalizationVersion, events,
    constraints: input.task.analysis.constraints,
    constraintLifecycle: input.task.analysis.constraints.map((constraint) => {
      const metric = input.verifier.nativeMetrics[constraint.verifierMetric ?? constraint.id]
      const satisfied = metric === true || typeof metric === 'number' && metric > 0
      const violated = metric === false || typeof metric === 'number' && metric <= 0
      return { constraintId: constraint.id, state: satisfied ? 'satisfied' as const : violated ? 'violated' as const : 'introduced' as const, eventSequence, evidenceRefs: [input.verifier.rawResultRef] }
    }),
    memoryProbes: memoryProbes(events), toolAttempts: toolAttempts(events), planSteps: planSteps(events),
    workspaceIntegrity: { changedPaths, deletedPaths, protectedPaths: input.task.analysis.protectedPaths, hiddenVerifierPaths: input.task.analysis.hiddenVerifierPaths, verifierLeakagePaths: hiddenTouched ? input.task.analysis.hiddenVerifierPaths.filter((path) => [...touched].some((changed) => isWithin(path, changed))) : [], suspiciousLiteralEvidenceRefs: [] },
    verifierIntegrity: { passed, protectedIntegrityPassed: !protectedTouched, hiddenVerifierPassed: !hiddenTouched, selectedTestFraction: 1, evidenceRefs: [input.verifier.rawResultRef] },
  }
  return AnalyzerInputSchema.parse({ ...unsigned, inputManifestHash: await sha256Hex(canonicalJson(unsigned)) })
}

function memoryProbes(events: readonly NormalizedAgentEvent[]): AnalyzerInput['memoryProbes'] {
  return events.filter((event) => event.kind === 'memory').flatMap((event) => {
    const value = record(event.data.analysisMemoryProbe)
    const probeId = string(value.probeId); const kind = memoryKind(value.kind); const outcome = memoryOutcome(value.outcome)
    if (!probeId || !kind || !outcome) return []
    return [{ probeId, introducedSequence: integer(value.introducedSequence) ?? event.sequence, observedSequence: event.sequence, kind, outcome, evidenceRefs: [eventRef(event)] }]
  })
}

function toolAttempts(events: readonly NormalizedAgentEvent[]): AnalyzerInput['toolAttempts'] {
  return events.filter((event) => event.kind === 'tool_call' || event.kind === 'command').map((event) => {
    const data = record(event.data); const analysis = record(data.analysisToolAttempt)
    const outcome = enumValue(analysis.outcome, ['success', 'failure', 'indeterminate'] as const) ?? inferredOutcome(data)
    const category = enumValue(analysis.failureCategory, ['agent_failure', 'invalid_action', 'unmet_precondition', 'environment_failure', 'provider_failure', 'verifier_failure', 'cancelled', 'timeout', 'indeterminate_side_effect'] as const)
    return {
      sequence: event.sequence, tool: string(analysis.tool) ?? string(data.tool) ?? string(data.name) ?? 'unknown-tool',
      schemaValid: boolean(analysis.schemaValid) ?? true, executable: boolean(analysis.executable) ?? true, outcome,
      ...(category ? { failureCategory: category } : {}),
      observedStateSufficientForRecovery: boolean(analysis.observedStateSufficientForRecovery) ?? outcome !== 'indeterminate',
      ...(integer(analysis.replayOfSequence) === undefined ? {} : { replayOfSequence: integer(analysis.replayOfSequence) }), evidenceRefs: [eventRef(event)],
    }
  })
}

function planSteps(events: readonly NormalizedAgentEvent[]): AnalyzerInput['planSteps'] {
  return events.flatMap((event) => {
    const value = record(event.data.analysisPlanStep); const stepId = string(value.stepId)
    if (!stepId) return []
    return [{
      stepId, prerequisiteStepIds: strings(value.prerequisiteStepIds), critical: boolean(value.critical) ?? false,
      ...(integer(value.startedSequence) === undefined ? {} : { startedSequence: integer(value.startedSequence) }),
      ...(integer(value.completedSequence) === undefined ? {} : { completedSequence: integer(value.completedSequence) }),
      ...(integer(value.verifiedSequence) === undefined ? {} : { verifiedSequence: integer(value.verifiedSequence) }),
      abandoned: boolean(value.abandoned) ?? false,
      ...(integer(value.contradictionSequence) === undefined ? {} : { contradictionSequence: integer(value.contradictionSequence) }),
      ...(integer(value.replannedSequence) === undefined ? {} : { replannedSequence: integer(value.replannedSequence) }), evidenceRefs: [eventRef(event)],
    }]
  })
}

function diffPaths(diff: string, deletedOnly: boolean): string[] {
  const paths = new Set<string>()
  let current: string | undefined; let deleted = false
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line)
    if (match) { if (current && deleted === deletedOnly) paths.add(current); current = match[2]; deleted = false; continue }
    if (line === 'deleted file mode 100644' || line.startsWith('deleted file mode ')) deleted = true
  }
  if (current && deleted === deletedOnly) paths.add(current)
  return [...paths].sort()
}
function inferredOutcome(data: Record<string, unknown>): 'success' | 'failure' | 'indeterminate' { const text = JSON.stringify(data); return /indeterminate/iu.test(text) ? 'indeterminate' : /error|fail/iu.test(text) ? 'failure' : 'success' }
function eventRef(event: NormalizedAgentEvent): string { return 'normalized-events.jsonl#' + String(event.sequence) }
function isWithin(root: string, path: string): boolean { return path === root || path.startsWith(root.replace(/\/$/u, '') + '/') }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined }
function boolean(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [] }
function enumValue<const T extends readonly string[]>(value: unknown, choices: T): T[number] | undefined { return typeof value === 'string' && choices.includes(value) ? value as T[number] : undefined }
function memoryKind(value: unknown) { return enumValue(value, ['retention', 'correction', 'deletion', 'isolation', 'compaction'] as const) }
function memoryOutcome(value: unknown) { return enumValue(value, ['retained', 'forgotten', 'stale_used', 'deletion_ignored', 'cross_contaminated', 'post_compaction_violation'] as const) }
