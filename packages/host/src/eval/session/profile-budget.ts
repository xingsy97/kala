/**
 * `eval profile-budget` command: reads a session profile artifact and a
 * threshold policy, then writes a budget verdict listing which thresholds
 * were breached and by how much. Companion to `eval regression-gate`, but
 * scoped to a single session's cost, tokens, latency, and TTFT rather than a
 * cross-experiment comparison.
 *
 * The gate never mutates the profile; it only reads it and emits
 * `profile-budget.json` under `--root-dir`. Exit code 2 signals a budget
 * breach so CI runners can block promotion without any extra scripting.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SessionProfile } from '@agent-kernel/shared/enhancement'

export type ProfileBudgetPolicy = {
  maxEstimatedCostUsd?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTotalTokens?: number
  maxLlmCalls?: number
  maxToolCalls?: number
  maxToolErrors?: number
  maxWallTimeMs?: number
  maxAverageLlmDurationMs?: number
  maxP95LlmDurationMs?: number
  maxAverageTimeToFirstChunkMs?: number
  maxP95TimeToFirstChunkMs?: number
  maxMissingUsageCalls?: number
  maxLlmTraceMissingCalls?: number
  requireCostEstimated?: boolean
}

export type ProfileBudgetInput = {
  rootDir: string
  profilePath: string
  policy: ProfileBudgetPolicy
  outputFilename?: string
}

export type ProfileBudgetReason = {
  code: string
  observed: number | string
  threshold: number | string
  message: string
}

export type ProfileBudgetVerdict = {
  pass: boolean
  profilePath: string
  profile: Pick<SessionProfile,
    | 'sessionId'
    | 'llmCalls'
    | 'toolCalls'
    | 'toolErrors'
    | 'totalInputTokens'
    | 'totalOutputTokens'
    | 'costStatus'
    | 'estimatedCostUsd'
    | 'wallTimeMs'
    | 'averageLlmDurationMs'
    | 'p95LlmDurationMs'
    | 'averageTimeToFirstChunkMs'
    | 'p95TimeToFirstChunkMs'
    | 'missingUsageCalls'
    | 'llmTraceMissingCalls'>
  policy: ProfileBudgetPolicy
  reasons: readonly ProfileBudgetReason[]
}

export async function evaluateProfileBudget(
  input: ProfileBudgetInput,
): Promise<{ verdict: ProfileBudgetVerdict; verdictPath: string }> {
  const profile = JSON.parse(await readFile(input.profilePath, 'utf8')) as SessionProfile
  const reasons: ProfileBudgetReason[] = []
  const policy = input.policy

  if (policy.requireCostEstimated && profile.costStatus !== 'estimated') {
    reasons.push({
      code: 'cost_status_unknown',
      observed: profile.costStatus,
      threshold: 'estimated',
      message: `profile.costStatus is ${profile.costStatus}; missing pricing or usage data`,
    })
  }
  if (policy.maxEstimatedCostUsd !== undefined && profile.estimatedCostUsd !== undefined && profile.estimatedCostUsd > policy.maxEstimatedCostUsd) {
    reasons.push(numericReason('cost_budget_exceeded', profile.estimatedCostUsd, policy.maxEstimatedCostUsd, 'estimatedCostUsd'))
  }
  const totalTokens = profile.totalInputTokens + profile.totalOutputTokens
  if (policy.maxInputTokens !== undefined && profile.totalInputTokens > policy.maxInputTokens) {
    reasons.push(numericReason('input_tokens_exceeded', profile.totalInputTokens, policy.maxInputTokens, 'totalInputTokens'))
  }
  if (policy.maxOutputTokens !== undefined && profile.totalOutputTokens > policy.maxOutputTokens) {
    reasons.push(numericReason('output_tokens_exceeded', profile.totalOutputTokens, policy.maxOutputTokens, 'totalOutputTokens'))
  }
  if (policy.maxTotalTokens !== undefined && totalTokens > policy.maxTotalTokens) {
    reasons.push(numericReason('total_tokens_exceeded', totalTokens, policy.maxTotalTokens, 'totalTokens'))
  }
  if (policy.maxLlmCalls !== undefined && profile.llmCalls > policy.maxLlmCalls) {
    reasons.push(numericReason('llm_calls_exceeded', profile.llmCalls, policy.maxLlmCalls, 'llmCalls'))
  }
  if (policy.maxToolCalls !== undefined && profile.toolCalls > policy.maxToolCalls) {
    reasons.push(numericReason('tool_calls_exceeded', profile.toolCalls, policy.maxToolCalls, 'toolCalls'))
  }
  if (policy.maxToolErrors !== undefined && profile.toolErrors > policy.maxToolErrors) {
    reasons.push(numericReason('tool_errors_exceeded', profile.toolErrors, policy.maxToolErrors, 'toolErrors'))
  }
  if (policy.maxWallTimeMs !== undefined && profile.wallTimeMs !== undefined && profile.wallTimeMs > policy.maxWallTimeMs) {
    reasons.push(numericReason('wall_time_exceeded', profile.wallTimeMs, policy.maxWallTimeMs, 'wallTimeMs'))
  }
  if (policy.maxAverageLlmDurationMs !== undefined && profile.averageLlmDurationMs !== undefined && profile.averageLlmDurationMs > policy.maxAverageLlmDurationMs) {
    reasons.push(numericReason('average_llm_duration_exceeded', profile.averageLlmDurationMs, policy.maxAverageLlmDurationMs, 'averageLlmDurationMs'))
  }
  if (policy.maxP95LlmDurationMs !== undefined && profile.p95LlmDurationMs !== undefined && profile.p95LlmDurationMs > policy.maxP95LlmDurationMs) {
    reasons.push(numericReason('p95_llm_duration_exceeded', profile.p95LlmDurationMs, policy.maxP95LlmDurationMs, 'p95LlmDurationMs'))
  }
  if (policy.maxAverageTimeToFirstChunkMs !== undefined && profile.averageTimeToFirstChunkMs !== undefined && profile.averageTimeToFirstChunkMs > policy.maxAverageTimeToFirstChunkMs) {
    reasons.push(numericReason('average_ttft_exceeded', profile.averageTimeToFirstChunkMs, policy.maxAverageTimeToFirstChunkMs, 'averageTimeToFirstChunkMs'))
  }
  if (policy.maxP95TimeToFirstChunkMs !== undefined && profile.p95TimeToFirstChunkMs !== undefined && profile.p95TimeToFirstChunkMs > policy.maxP95TimeToFirstChunkMs) {
    reasons.push(numericReason('p95_ttft_exceeded', profile.p95TimeToFirstChunkMs, policy.maxP95TimeToFirstChunkMs, 'p95TimeToFirstChunkMs'))
  }
  if (policy.maxMissingUsageCalls !== undefined && profile.missingUsageCalls > policy.maxMissingUsageCalls) {
    reasons.push(numericReason('missing_usage_exceeded', profile.missingUsageCalls, policy.maxMissingUsageCalls, 'missingUsageCalls'))
  }
  if (policy.maxLlmTraceMissingCalls !== undefined && profile.llmTraceMissingCalls > policy.maxLlmTraceMissingCalls) {
    reasons.push(numericReason('missing_trace_exceeded', profile.llmTraceMissingCalls, policy.maxLlmTraceMissingCalls, 'llmTraceMissingCalls'))
  }

  const verdict: ProfileBudgetVerdict = {
    pass: reasons.length === 0,
    profilePath: input.profilePath,
    profile: pickProfile(profile),
    policy,
    reasons,
  }
  await mkdir(input.rootDir, { recursive: true })
  const verdictPath = join(input.rootDir, input.outputFilename ?? 'profile-budget.json')
  await writeFile(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
  return { verdict, verdictPath }
}

function pickProfile(profile: SessionProfile): ProfileBudgetVerdict['profile'] {
  return {
    sessionId: profile.sessionId,
    llmCalls: profile.llmCalls,
    toolCalls: profile.toolCalls,
    toolErrors: profile.toolErrors,
    totalInputTokens: profile.totalInputTokens,
    totalOutputTokens: profile.totalOutputTokens,
    costStatus: profile.costStatus,
    ...(profile.estimatedCostUsd !== undefined ? { estimatedCostUsd: profile.estimatedCostUsd } : {}),
    ...(profile.wallTimeMs !== undefined ? { wallTimeMs: profile.wallTimeMs } : {}),
    ...(profile.averageLlmDurationMs !== undefined ? { averageLlmDurationMs: profile.averageLlmDurationMs } : {}),
    ...(profile.p95LlmDurationMs !== undefined ? { p95LlmDurationMs: profile.p95LlmDurationMs } : {}),
    ...(profile.averageTimeToFirstChunkMs !== undefined ? { averageTimeToFirstChunkMs: profile.averageTimeToFirstChunkMs } : {}),
    ...(profile.p95TimeToFirstChunkMs !== undefined ? { p95TimeToFirstChunkMs: profile.p95TimeToFirstChunkMs } : {}),
    missingUsageCalls: profile.missingUsageCalls,
    llmTraceMissingCalls: profile.llmTraceMissingCalls,
  }
}

function numericReason(code: string, observed: number, threshold: number, field: string): ProfileBudgetReason {
  return {
    code,
    observed,
    threshold,
    message: `${field}=${observed} exceeds threshold ${threshold}`,
  }
}

/**
 * Parses paired `--threshold field=value` args into a partial policy record.
 * Recognized fields correspond to the `ProfileBudgetPolicy` keys minus the
 * leading `max`, using camelCase field ids such as `cost`, `inputTokens`,
 * `outputTokens`, `wallTimeMs`, `p95LlmDurationMs`. Returns undefined when no
 * arguments match so callers can omit an empty object.
 */
export function parseThresholdArgs(argv: readonly string[]): Partial<ProfileBudgetPolicy> | undefined {
  const policy: Partial<ProfileBudgetPolicy> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg !== '--threshold') continue
    const next = argv[i + 1]
    if (!next) throw new Error('--threshold requires a field=value argument')
    const eq = next.indexOf('=')
    if (eq <= 0) throw new Error(`--threshold value must be field=value, got: ${next}`)
    const field = next.slice(0, eq).trim()
    const raw = next.slice(eq + 1)
    const key = fieldNameToPolicyKey(field)
    if (!key) throw new Error(`--threshold field is not recognized: ${field}`)
    if (key === 'requireCostEstimated') {
      const flag = raw === 'true' || raw === '1'
      const off = raw === 'false' || raw === '0'
      if (!flag && !off) throw new Error(`--threshold ${field} must be boolean, got: ${raw}`)
      policy.requireCostEstimated = flag
      continue
    }
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) throw new Error(`--threshold ${field} must be a non-negative number, got: ${raw}`)
    policy[key] = value
  }
  return Object.keys(policy).length > 0 ? policy : undefined
}

function fieldNameToPolicyKey(field: string): keyof ProfileBudgetPolicy | undefined {
  switch (field) {
    case 'cost':
    case 'costUsd':
    case 'maxCost':
      return 'maxEstimatedCostUsd'
    case 'inputTokens':
      return 'maxInputTokens'
    case 'outputTokens':
      return 'maxOutputTokens'
    case 'totalTokens':
      return 'maxTotalTokens'
    case 'llmCalls':
      return 'maxLlmCalls'
    case 'toolCalls':
      return 'maxToolCalls'
    case 'toolErrors':
      return 'maxToolErrors'
    case 'wallTimeMs':
      return 'maxWallTimeMs'
    case 'averageLlmDurationMs':
      return 'maxAverageLlmDurationMs'
    case 'p95LlmDurationMs':
      return 'maxP95LlmDurationMs'
    case 'averageTimeToFirstChunkMs':
    case 'averageTtftMs':
      return 'maxAverageTimeToFirstChunkMs'
    case 'p95TimeToFirstChunkMs':
    case 'p95TtftMs':
      return 'maxP95TimeToFirstChunkMs'
    case 'missingUsageCalls':
      return 'maxMissingUsageCalls'
    case 'llmTraceMissingCalls':
      return 'maxLlmTraceMissingCalls'
    case 'requireCostEstimated':
      return 'requireCostEstimated'
    default:
      return undefined
  }
}
