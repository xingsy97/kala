import { createHash } from 'node:crypto'

import {
  FailureClusterPromotionSchema, FailureClusterSchema, TraceAlignmentResultSchema, canonicalJson,
  type DefectCategory, type DefectFinding, type FailureCluster, type FailureClusterPromotion,
  type NormalizedAgentEvent, type TraceAlignmentResult,
} from '@agent-kernel/eval-protocol'

type TrialOutcome = 'success' | 'failure'
type AlignmentOptions = { leftOutcome?: TrialOutcome; rightOutcome?: TrialOutcome }
type MeaningfulEvent = { event: NormalizedAgentEvent; signature: string; signatureHash: string }

const MEANINGFUL_KINDS = new Set<NormalizedAgentEvent['kind']>(['tool_call', 'command', 'subagent', 'compaction', 'memory', 'status', 'error'])
const VOLATILE_KEYS = /^(?:at|timestamp|time|durationMs|latencyMs|elapsedMs|nativeEventRef|runId|trialId|sessionId|requestId|callId)$/u

export function alignTraces(
  leftTrialId: string,
  left: readonly NormalizedAgentEvent[],
  rightTrialId: string,
  right: readonly NormalizedAgentEvent[],
  options: AlignmentOptions = {},
): TraceAlignmentResult {
  const leftOutcome = options.leftOutcome ?? inferOutcome(left)
  const rightOutcome = options.rightOutcome ?? inferOutcome(right)
  const leftMeaningful = meaningfulEvents(left)
  const rightMeaningful = meaningfulEvents(right)
  let commonPrefixLength = 0
  while (
    commonPrefixLength < leftMeaningful.length
    && commonPrefixLength < rightMeaningful.length
    && leftMeaningful[commonPrefixLength]!.signature === rightMeaningful[commonPrefixLength]!.signature
  ) commonPrefixLength += 1

  const alignedPairs = Array.from({ length: commonPrefixLength }, (_unused, index) => [
    leftMeaningful[index]!.event.sequence, rightMeaningful[index]!.event.sequence,
  ] as [number, number])
  const leftDivergence = leftMeaningful[commonPrefixLength]
  const rightDivergence = rightMeaningful[commonPrefixLength]
  const leftStart = leftDivergence?.event.sequence ?? left.length
  const rightStart = rightDivergence?.event.sequence ?? right.length
  const leftSuffix = leftMeaningful.length - commonPrefixLength
  const rightSuffix = rightMeaningful.length - commonPrefixLength
  const successful = leftOutcome === rightOutcome ? undefined : leftOutcome === 'success'
    ? { successfulTrialId: leftTrialId, failedTrialId: rightTrialId, event: leftDivergence }
    : { successfulTrialId: rightTrialId, failedTrialId: leftTrialId, event: rightDivergence }
  const failedSuffix = leftOutcome === 'failure' && rightOutcome === 'success' ? leftSuffix : rightOutcome === 'failure' && leftOutcome === 'success' ? rightSuffix : leftSuffix
  const successfulSuffix = leftOutcome === 'success' && rightOutcome === 'failure' ? leftSuffix : rightOutcome === 'success' && leftOutcome === 'failure' ? rightSuffix : rightSuffix

  return TraceAlignmentResultSchema.parse({
    schemaVersion: 1, leftTrialId, rightTrialId, leftOutcome, rightOutcome, commonPrefixLength, alignedPairs,
    additionalLoopCost: Math.max(0, failedSuffix - successfulSuffix),
    costAfterDivergence: {
      leftEvents: leftSuffix, rightEvents: rightSuffix,
      leftWallMs: wallMsAfter(left, leftStart), rightWallMs: wallMsAfter(right, rightStart),
      leftCostUsd: costAfter(left, leftStart), rightCostUsd: costAfter(right, rightStart),
    },
    ...(!leftDivergence && !rightDivergence ? {} : { firstDivergence: {
      ...(leftDivergence ? { leftSequence: leftDivergence.event.sequence, leftKind: leftDivergence.event.kind, leftSignature: leftDivergence.signatureHash } : {}),
      ...(rightDivergence ? { rightSequence: rightDivergence.event.sequence, rightKind: rightDivergence.event.kind, rightSignature: rightDivergence.signatureHash } : {}),
    } }),
    ...(successful?.event ? { missingSuccessfulAction: {
      successfulTrialId: successful.successfulTrialId, failedTrialId: successful.failedTrialId,
      sequence: successful.event.event.sequence, kind: successful.event.event.kind, signature: successful.event.signatureHash,
    } } : {}),
  })
}

export function clusterUnknownFailures(inputs: readonly { finding: DefectFinding; actionErrorSequence: readonly string[] }[]): FailureCluster[] {
  const groups = new Map<string, typeof inputs[number][]>()
  for (const input of inputs) {
    if (input.finding.category !== 'unknown') continue
    const signature = hash(canonicalJson(input.actionErrorSequence))
    groups.set(signature, [...(groups.get(signature) ?? []), input])
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([signature, members]) => FailureClusterSchema.parse({
    schemaVersion: 1, clusterId: 'unknown-' + signature.slice(0, 20), signature, memberFindingIds: members.map((member) => member.finding.findingId).sort(), method: 'deterministic-action-error-signature', status: 'unknown',
  }))
}

export function humanPromoteCluster(cluster: FailureCluster, humanName: string, promotedCategory: Exclude<DefectCategory, 'unknown'>): FailureCluster {
  return FailureClusterSchema.parse({ ...cluster, status: 'human_named', humanName, promotedCategory })
}

export function recordHumanClusterPromotion(input: {
  promotionId: string; sourceJobId: string; runId: string; cluster: FailureCluster; humanName: string;
  promotedCategory: Exclude<DefectCategory, 'unknown'>; promotedBy: { actorId: string; authority: 'operator' | 'reviewer' }; promotedAt: string
}): FailureClusterPromotion {
  return FailureClusterPromotionSchema.parse({
    schemaVersion: 1, promotionId: input.promotionId, sourceJobId: input.sourceJobId, runId: input.runId,
    cluster: humanPromoteCluster(input.cluster, input.humanName, input.promotedCategory),
    promotedBy: input.promotedBy, promotedAt: input.promotedAt,
  })
}

function meaningfulEvents(events: readonly NormalizedAgentEvent[]): MeaningfulEvent[] {
  return events.filter((event) => MEANINGFUL_KINDS.has(event.kind)).map((event) => {
    const signature = canonicalJson({ kind: event.kind, data: stableData(event.data) })
    return { event, signature, signatureHash: hash(signature) }
  })
}

function stableData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableData)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !VOLATILE_KEYS.test(key)).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableData(entry)]))
}

function inferOutcome(events: readonly NormalizedAgentEvent[]): TrialOutcome {
  const terminal = [...events].reverse().find((event) => event.kind === 'status')
  const state = typeof terminal?.data.state === 'string' ? terminal.data.state.toLowerCase() : ''
  return /^(?:done|completed|passed|success)$/u.test(state) ? 'success' : 'failure'
}

function wallMsAfter(events: readonly NormalizedAgentEvent[], startSequence: number): number {
  const suffix = events.filter((event) => event.sequence >= startSequence)
  if (suffix.length < 2) return 0
  return Math.max(0, Date.parse(suffix.at(-1)!.at) - Date.parse(suffix[0]!.at))
}

function costAfter(events: readonly NormalizedAgentEvent[], startSequence: number): number {
  return events.filter((event) => event.kind === 'usage' && event.sequence >= startSequence).reduce((total, event) => total + finiteNumber(event.data.costUsd), 0)
}

function finiteNumber(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
