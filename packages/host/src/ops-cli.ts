import {
  exportRolloutFrameworkAdapter,
  exportRolloutSidecar,
  exportRolloutSegments,
  type ExportRolloutAdapterInput,
  type ExportRolloutSidecarInput,
} from './rl-export.js'
import { verifyReward, type VerifyRewardInput } from './rl-reward.js'
import {
  exportSessionTraceArtifacts,
  type ExportSessionTraceInput,
} from './session-export.js'
import {
  exportTraceOtlp,
  loadHeadersFile,
  parseHeaderArgs,
  type TraceExportOtlpInput,
} from './trace-otlp-export.js'
import { buildArtifactManifest, pruneArtifacts, type BuildArtifactManifestInput, type PruneArtifactsInput } from './artifact-manifest.js'
import {
  compareEvalRuns,
  judgeScore,
  profileSession,
  scoreSession,
  type CompareEvalRunsInput,
  type JudgeScoreInput,
  type ProfileSessionInput,
  type ScoreSessionInput,
} from './eval/generic.js'
import {
  evaluateRegressionGate,
  parseFailureCapArgs,
  type RegressionGateInput,
} from './eval/regression-gate.js'
import {
  aggregateProfiles,
  type ProfileAggregateInput,
} from './eval/cost-aggregate.js'
import {
  evaluateProfileBudget,
  parseThresholdArgs,
  type ProfileBudgetInput,
} from './eval/profile-budget.js'
import { auditSessionReliability, replayReliabilityChaos, type AuditSessionReliabilityInput, type ReliabilityChaosReplayInput } from './reliability.js'
import {
  evaluateReliabilityGate,
  parseKindCapArgs,
  type ReliabilityGateInput,
  type ReliabilityGatePolicy,
} from './reliability-gate.js'
import { classifyReliability, type ClassifyReliabilityInput } from './reliability-classify.js'
import { diffToolCatalogs, type ToolCatalogDiffInput } from './tool-catalog-diff.js'
import { writeExecutorCapabilitySnapshot } from './executor-capabilities.js'
import { buildMemoryIndex, type BuildMemoryIndexInput } from './memory-index.js'
import { retrieveMemory, type MemoryRetrievalInput } from './memory-retrieval.js'
import { exportSubAgentGraph, type ExportSubAgentGraphInput } from './subagent-graph.js'
import { loadTaskPoolFile, type TaskPoolValidation } from './rl/task-pool.js'
import { writeTokenCaptureArtifact, type TokenCaptureValidation } from './rl/token-capture.js'
import { buildTrajectory, validateSlimeSampleReadiness } from './rl/trajectory-builder.js'
import { runRlRollout } from './rl/rollout-runner.js'
import { policyGatewayAdapter } from './llm/policy-gateway.js'
import type { LLMAdapter } from './llm/adapter.js'
import { readFile } from 'node:fs/promises'

export type EnhancementCliCommand =
  | { kind: 'none' }
  | ({ kind: 'eval-score-session' } & ScoreSessionInput)
  | ({ kind: 'eval-judge-score' } & JudgeScoreInput)
  | ({ kind: 'eval-compare-runs' } & CompareEvalRunsInput)
  | ({ kind: 'eval-regression-gate' } & RegressionGateInput)
  | ({ kind: 'profile-session' } & ProfileSessionInput)
  | ({ kind: 'profile-aggregate' } & ProfileAggregateInput)
  | ({ kind: 'profile-budget' } & ProfileBudgetInput)
  | ({ kind: 'reliability-audit-session' } & AuditSessionReliabilityInput)
  | ({ kind: 'reliability-chaos-replay' } & ReliabilityChaosReplayInput)
  | ({ kind: 'reliability-gate' } & ReliabilityGateInput)
  | ({ kind: 'reliability-classify' } & ClassifyReliabilityInput)
  | ({ kind: 'tool-catalog-diff' } & ToolCatalogDiffInput)
  | { kind: 'executor-capabilities-snapshot'; rootDir: string; outputFilename?: string; executorsPath?: string }
  | ({ kind: 'memory-index' } & BuildMemoryIndexInput)
  | ({ kind: 'memory-retrieve' } & MemoryRetrievalInput)
  | ({ kind: 'subagents-graph' } & ExportSubAgentGraphInput)
  | ({ kind: 'artifacts-manifest' } & BuildArtifactManifestInput)
  | ({ kind: 'artifacts-prune' } & PruneArtifactsInput)
  | ({ kind: 'trace-export-session' } & ExportSessionTraceInput)
  | ({ kind: 'trace-export-otlp' } & TraceExportOtlpInput & { headersFilePath?: string })
  | ({ kind: 'rollout-export-session' } & ExportRolloutSidecarInput)
  | ({ kind: 'rollout-export-segments' } & ExportSessionTraceInput)
  | ({ kind: 'rollout-export-adapter' } & ExportRolloutAdapterInput)
  | ({ kind: 'rollout-verify-reward' } & VerifyRewardInput)
  | { kind: 'rl-validate-task-pool'; taskFile: string; trainingMode: boolean; workspaceRoot?: string }
  | { kind: 'rl-write-token-capture-fixture'; rootDir: string; rolloutId: string; sessionId: string; callId: string; taskId?: string; model: string; requireLogprobs: boolean }
  | { kind: 'rl-build-trajectory'; rootDir: string; rolloutId: string; taskId: string; sessionId: string; tokenCaptures: readonly string[]; rewardPath?: string }
  | { kind: 'rl-validate-slime-sample'; rootDir: string; trajectoryPath: string; rewardPath: string; requireLogprobs: boolean }
  | { kind: 'rl-run-rollout-smoke'; rootDir: string; taskFile: string; taskId?: string; rolloutId?: string; policyBaseUrl?: string; model: string; tokenizerPath?: string; requireLogprobs: boolean; timeoutMs?: number; maxNewTokens?: number; fixturePolicy: boolean }
  | { kind: 'rl-inspect-rollout'; rootDir: string; rolloutPath: string }

export function parseEnhancementCli(argv: readonly string[]): EnhancementCliCommand {
  const commandArgv = argv[0] === 'rl' ? ['enhancement', ...argv] : argv
  if (commandArgv[0] !== 'enhancement') return { kind: 'none' }
  if (commandArgv[1] === 'trace' && commandArgv[2] === 'export-session') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'trace-export-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/enhancement',
      sessionLogPath: required(rest, '--session-log'),
      runId: value(rest, '--run-id'),
      evalInstanceId: value(rest, '--eval-instance-id'),
      workspaceRoot: value(rest, '--workspace-root'),
    }
  }
  if (commandArgv[1] === 'trace' && commandArgv[2] === 'export-otlp') {
    const rest = commandArgv.slice(3)
    const headers = parseHeaderArgs(rest)
    const retries = numberValue(rest, '--retries')
    const retryDelayMs = numberValue(rest, '--retry-delay-ms')
    const timeoutMs = numberValue(rest, '--timeout-ms')
    const headersFilePath = value(rest, '--headers-file')
    return {
      kind: 'trace-export-otlp',
      rootDir: value(rest, '--root-dir') ?? 'runs/enhancement',
      sessionLogPath: required(rest, '--session-log'),
      runId: value(rest, '--run-id'),
      evalInstanceId: value(rest, '--eval-instance-id'),
      endpoint: value(rest, '--endpoint'),
      ...(headers ? { headers } : {}),
      ...(headersFilePath ? { headersFilePath } : {}),
      ...(retries !== undefined ? { retries } : {}),
      ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      outputFilename: value(rest, '--output'),
      serviceName: value(rest, '--service-name'),
      hostVersion: value(rest, '--host-version'),
    }
  }
  if (commandArgv[1] === 'eval' && commandArgv[2] === 'score-session') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'eval-score-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/eval/session-score',
      sessionLogPath: required(rest, '--session-log'),
      instanceId: value(rest, '--instance-id'),
      patchPath: value(rest, '--patch'),
      requireDone: flag(rest, '--require-done'),
      workspaceRoot: value(rest, '--workspace-root'),
    }
  }
  if (commandArgv[1] === 'eval' && commandArgv[2] === 'compare-runs') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'eval-compare-runs',
      rootDir: value(rest, '--root-dir') ?? 'runs/eval/compare',
      baselineSummaryPath: required(rest, '--baseline-summary'),
      candidateSummaryPath: required(rest, '--candidate-summary'),
    }
  }
  if (commandArgv[1] === 'eval' && commandArgv[2] === 'regression-gate') {
    const rest = commandArgv.slice(3)
    const failureLabelCaps = parseFailureCapArgs(rest)
    const minPassRate = numberValue(rest, '--min-pass-rate')
    const maxPassRateDrop = numberValue(rest, '--max-pass-rate-drop')
    const maxFailedIncrease = numberValue(rest, '--max-failed-increase')
    const maxTimeoutIncrease = numberValue(rest, '--max-timeout-increase')
    const maxResolvedDrop = numberValue(rest, '--max-resolved-drop')
    const policy = {
      ...(minPassRate !== undefined ? { minPassRate } : {}),
      ...(maxPassRateDrop !== undefined ? { maxPassRateDrop } : {}),
      ...(maxFailedIncrease !== undefined ? { maxFailedIncrease } : {}),
      ...(maxTimeoutIncrease !== undefined ? { maxTimeoutIncrease } : {}),
      ...(maxResolvedDrop !== undefined ? { maxResolvedDrop } : {}),
      ...(failureLabelCaps ? { failureLabelCaps } : {}),
    }
    return {
      kind: 'eval-regression-gate',
      rootDir: value(rest, '--root-dir') ?? 'runs/eval/regression-gate',
      baselineSummaryPath: required(rest, '--baseline-summary'),
      candidateSummaryPath: required(rest, '--candidate-summary'),
      outputFilename: value(rest, '--output'),
      policy,
    }
  }
  if (commandArgv[1] === 'eval' && commandArgv[2] === 'judge-score') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'eval-judge-score',
      rootDir: value(rest, '--root-dir') ?? 'runs/eval/judge-score',
      promptPath: required(rest, '--prompt'),
      responsePath: required(rest, '--response'),
      judgeModel: required(rest, '--judge-model'),
      scorer: value(rest, '--scorer'),
      instanceId: value(rest, '--instance-id'),
      threshold: numberValue(rest, '--threshold'),
      inputRef: value(rest, '--input-ref'),
      workspaceRoot: value(rest, '--workspace-root'),
    }
  }
  if (commandArgv[1] === 'profile' && commandArgv[2] === 'session') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'profile-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/profile/session',
      sessionLogPath: required(rest, '--session-log'),
      pricingPath: value(rest, '--pricing'),
    }
  }
  if (commandArgv[1] === 'profile' && commandArgv[2] === 'aggregate') {
    const rest = commandArgv.slice(3)
    const summaryPath = value(rest, '--summary')
    const output = value(rest, '--output')
    return {
      kind: 'profile-aggregate',
      rootDir: value(rest, '--root-dir') ?? 'runs/profile/aggregate',
      ...(summaryPath ? { summaryPath } : {}),
      ...(output ? { outputFilename: output } : {}),
    }
  }
  if (commandArgv[1] === 'profile' && commandArgv[2] === 'budget') {
    const rest = commandArgv.slice(3)
    const output = value(rest, '--output')
    const parsed = parseThresholdArgs(rest) ?? {}
    return {
      kind: 'profile-budget',
      rootDir: value(rest, '--root-dir') ?? 'runs/profile/budget',
      profilePath: required(rest, '--profile'),
      policy: parsed,
      ...(output ? { outputFilename: output } : {}),
    }
  }
  if (commandArgv[1] === 'reliability' && commandArgv[2] === 'audit-session') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'reliability-audit-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/reliability/session',
      sessionLogPath: required(rest, '--session-log'),
    }
  }
  if (commandArgv[1] === 'reliability' && commandArgv[2] === 'chaos-replay') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'reliability-chaos-replay',
      rootDir: value(rest, '--root-dir') ?? 'runs/reliability/chaos',
      sessionLogPaths: listValue(rest, '--session-logs'),
    }
  }
  if (commandArgv[1] === 'reliability' && commandArgv[2] === 'gate') {
    const rest = commandArgv.slice(3)
    const policy: ReliabilityGatePolicy = {}
    const maxDanglingCount = numberValue(rest, '--max-dangling')
    const minRecoverableRatio = numberValue(rest, '--min-recoverable-ratio')
    const maxRecoveryEventCount = numberValue(rest, '--max-recovery-events')
    if (maxDanglingCount !== undefined) policy.maxDanglingCount = maxDanglingCount
    if (minRecoverableRatio !== undefined) policy.minRecoverableRatio = minRecoverableRatio
    if (maxRecoveryEventCount !== undefined) policy.maxRecoveryEventCount = maxRecoveryEventCount
    const kindCaps = parseKindCapArgs(rest)
    if (kindCaps) policy.maxDanglingByKind = kindCaps
    const requireStatus = optionalListValue(rest, '--require-status')
    if (requireStatus) policy.requireStatusIn = requireStatus
    const chaosReport = value(rest, '--chaos-report')
    const sessionLogsRaw = value(rest, '--session-logs')
    if (!chaosReport && !sessionLogsRaw) throw new Error('reliability gate requires --chaos-report or --session-logs')
    const output = value(rest, '--output')
    return {
      kind: 'reliability-gate',
      rootDir: value(rest, '--root-dir') ?? 'runs/reliability/gate',
      ...(chaosReport ? { chaosReportPath: chaosReport } : {}),
      ...(sessionLogsRaw ? { sessionLogPaths: listValue(rest, '--session-logs') } : {}),
      policy,
      ...(output ? { outputFilename: output } : {}),
    }
  }
  if (commandArgv[1] === 'reliability' && commandArgv[2] === 'classify') {
    const rest = commandArgv.slice(3)
    const wedgedThresholdMs = numberValue(rest, '--wedged-threshold-ms')
    return {
      kind: 'reliability-classify',
      rootDir: value(rest, '--root-dir') ?? 'runs/reliability/classify',
      sessionLogPath: required(rest, '--session-log'),
      heartbeatPath: required(rest, '--heartbeat'),
      ...(wedgedThresholdMs !== undefined ? { wedgedThresholdMs } : {}),
    }
  }
  if (commandArgv[1] === 'tool-catalog' && commandArgv[2] === 'diff') {
    const rest = commandArgv.slice(3)
    const output = value(rest, '--output')
    return {
      kind: 'tool-catalog-diff',
      rootDir: value(rest, '--root-dir') ?? 'runs/router/tool-catalog-diff',
      baselinePath: required(rest, '--baseline'),
      candidatePath: required(rest, '--candidate'),
      ...(output ? { outputFilename: output } : {}),
    }
  }
  if (commandArgv[1] === 'executor-capabilities' && commandArgv[2] === 'snapshot') {
    const rest = commandArgv.slice(3)
    const output = value(rest, '--output')
    const executorsPath = value(rest, '--executors')
    return {
      kind: 'executor-capabilities-snapshot',
      rootDir: value(rest, '--root-dir') ?? 'runs/router/executor-capabilities',
      ...(output ? { outputFilename: output } : {}),
      ...(executorsPath ? { executorsPath } : {}),
    }
  }
  if (commandArgv[1] === 'memory' && commandArgv[2] === 'index') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'memory-index',
      rootDir: value(rest, '--root-dir') ?? 'runs/memory',
      workspaceRoot: value(rest, '--workspace-root'),
      includeGlobal: flag(rest, '--include-global'),
    }
  }
  if (commandArgv[1] === 'memory' && commandArgv[2] === 'retrieve') {
    const rest = commandArgv.slice(3)
    const maxTokens = numberValue(rest, '--max-tokens')
    const maxHits = numberValue(rest, '--max-hits')
    const workspaceRoot = value(rest, '--workspace-root')
    const output = value(rest, '--output')
    return {
      kind: 'memory-retrieve',
      rootDir: value(rest, '--root-dir') ?? 'runs/memory',
      ...(workspaceRoot ? { workspaceRoot } : {}),
      includeGlobal: flag(rest, '--include-global'),
      query: required(rest, '--query'),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(maxHits === undefined ? {} : { maxHits }),
      ...(output ? { outputFilename: output } : {}),
    }
  }
  if (commandArgv[1] === 'subagents' && commandArgv[2] === 'graph') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'subagents-graph',
      rootDir: value(rest, '--root-dir') ?? 'runs/subagents',
      sessionsDir: required(rest, '--sessions-dir'),
    }
  }
  if (commandArgv[1] === 'rollout' && commandArgv[2] === 'export-session') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'rollout-export-session',
      rootDir: value(rest, '--root-dir') ?? 'runs/rollouts',
      sessionLogPath: required(rest, '--session-log'),
      taskId: required(rest, '--task-id'),
      frameworkTarget: frameworkTarget(required(rest, '--framework')),
      runId: value(rest, '--run-id'),
      evalInstanceId: value(rest, '--eval-instance-id'),
      workspaceRoot: value(rest, '--workspace-root'),
      model: value(rest, '--model'),
      weightVersion: value(rest, '--weight-version'),
      rewardPath: value(rest, '--reward'),
      tokenSegmentsPath: value(rest, '--token-segments'),
    }
  }
  if (commandArgv[1] === 'rollout' && commandArgv[2] === 'export-segments') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'rollout-export-segments',
      rootDir: value(rest, '--root-dir') ?? 'runs/rollouts',
      sessionLogPath: required(rest, '--session-log'),
      runId: value(rest, '--run-id'),
      evalInstanceId: value(rest, '--eval-instance-id'),
      workspaceRoot: value(rest, '--workspace-root'),
    }
  }
  if (commandArgv[1] === 'rollout' && commandArgv[2] === 'export-adapter') {
    const rest = commandArgv.slice(3)
    const framework = value(rest, '--framework')
    return {
      kind: 'rollout-export-adapter',
      rootDir: value(rest, '--root-dir') ?? 'runs/rollouts',
      sidecarPath: required(rest, '--sidecar'),
      ...(framework ? { frameworkTarget: frameworkTarget(framework) } : {}),
    }
  }
  if (commandArgv[1] === 'rollout' && commandArgv[2] === 'verify-reward') {
    const rest = commandArgv.slice(3)
    const trialPath = value(rest, '--trial')
    const scorePath = value(rest, '--score')
    if (!trialPath && !scorePath) throw new Error('missing required --trial or --score')
    return {
      kind: 'rollout-verify-reward',
      rootDir: value(rest, '--root-dir') ?? 'runs/rollouts',
      ...(trialPath ? { trialPath } : {}),
      ...(scorePath ? { scorePath } : {}),
      ...(value(rest, '--task-id') ? { taskId: value(rest, '--task-id')! } : {}),
      ...(value(rest, '--session-id') ? { sessionId: value(rest, '--session-id')! } : {}),
      ...(value(rest, '--workspace-root') ? { workspaceRoot: value(rest, '--workspace-root')! } : {}),
    }
  }
  if (commandArgv[1] === 'rl' && commandArgv[2] === 'validate-task-pool') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'rl-validate-task-pool',
      taskFile: required(rest, '--task-file'),
      trainingMode: flag(rest, '--training-mode'),
      workspaceRoot: value(rest, '--workspace-root'),
    }
  }
  if (commandArgv[1] === 'rl' && commandArgv[2] === 'write-token-capture-fixture') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'rl-write-token-capture-fixture',
      rootDir: value(rest, '--root-dir') ?? 'runs/rl-smoke',
      rolloutId: required(rest, '--rollout-id'),
      sessionId: required(rest, '--session-id'),
      callId: required(rest, '--call-id'),
      taskId: value(rest, '--task-id'),
      model: value(rest, '--model') ?? 'fake-policy',
      requireLogprobs: flag(rest, '--require-logprobs'),
    }
  }
  if (commandArgv[1] === 'rl' && commandArgv[2] === 'build-trajectory') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'rl-build-trajectory',
      rootDir: value(rest, '--root-dir') ?? 'runs/rl-smoke',
      rolloutId: required(rest, '--rollout-id'),
      taskId: required(rest, '--task-id'),
      sessionId: required(rest, '--session-id'),
      tokenCaptures: listValue(rest, '--token-captures'),
      rewardPath: value(rest, '--reward'),
    }
  }
  if (commandArgv[1] === 'rl' && commandArgv[2] === 'validate-slime-sample') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'rl-validate-slime-sample',
      rootDir: value(rest, '--root-dir') ?? 'runs/rl-smoke',
      trajectoryPath: required(rest, '--trajectory'),
      rewardPath: required(rest, '--reward'),
      requireLogprobs: flag(rest, '--require-logprobs'),
    }
  }
  if (commandArgv[1] === 'rl' && commandArgv[2] === 'run-rollout-smoke') {
    const rest = commandArgv.slice(3)
    const timeoutMs = numberValue(rest, '--timeout-ms')
    const maxNewTokens = numberValue(rest, '--max-new-tokens')
    return {
      kind: 'rl-run-rollout-smoke',
      rootDir: value(rest, '--root-dir') ?? 'runs/rl-smoke',
      taskFile: required(rest, '--task-file'),
      taskId: value(rest, '--task-id'),
      rolloutId: value(rest, '--rollout-id'),
      policyBaseUrl: value(rest, '--policy-base-url') ?? process.env.AGENT_KERNEL_POLICY_BASE_URL,
      model: value(rest, '--model') ?? process.env.AGENT_KERNEL_POLICY_MODEL ?? 'policy-model-unspecified',
      tokenizerPath: value(rest, '--tokenizer') ?? process.env.AGENT_KERNEL_POLICY_TOKENIZER,
      requireLogprobs: flag(rest, '--require-logprobs'),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxNewTokens !== undefined ? { maxNewTokens } : {}),
      fixturePolicy: flag(rest, '--fixture-policy'),
    }
  }
  if (commandArgv[1] === 'rl' && commandArgv[2] === 'inspect-rollout') {
    const rest = commandArgv.slice(3)
    return {
      kind: 'rl-inspect-rollout',
      rootDir: value(rest, '--root-dir') ?? 'runs/rl-smoke',
      rolloutPath: required(rest, '--rollout'),
    }
  }
  if (commandArgv[1] === 'artifacts' && commandArgv[2] === 'manifest') {
    const rest = commandArgv.slice(3)
    const maxHashBytes = numberValue(rest, '--max-hash-bytes')
    return {
      kind: 'artifacts-manifest',
      rootDir: value(rest, '--root-dir') ?? 'runs/enhancement',
      outputPath: value(rest, '--output'),
      ...(maxHashBytes === undefined ? {} : { maxHashBytes }),
    }
  }
  if (commandArgv[1] === 'artifacts' && commandArgv[2] === 'prune') {
    const rest = commandArgv.slice(3)
    const olderThanDays = numberValue(rest, '--older-than-days')
    const maxTotalBytes = numberValue(rest, '--max-total-bytes')
    const kindsArg = value(rest, '--kinds')
    const kinds = kindsArg
      ? kindsArg.split(',').map((k) => k.trim()).filter((k) => k.length > 0)
      : undefined
    return {
      kind: 'artifacts-prune',
      rootDir: value(rest, '--root-dir') ?? 'runs/enhancement',
      ...(olderThanDays === undefined ? {} : { olderThanDays }),
      ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
      ...(kinds && kinds.length > 0 ? { kinds } : {}),
      dryRun: rest.includes('--dry-run'),
      ...(value(rest, '--output') ? { outputPath: value(rest, '--output')! } : {}),
    }
  }
  throw new Error(`unknown enhancement command: ${commandArgv.slice(1).join(' ') || '<missing>'}`)
}

export async function runEnhancementCli(command: EnhancementCliCommand): Promise<boolean> {
  if (command.kind === 'none') return false
  if (command.kind === 'trace-export-session') {
    const result = await exportSessionTraceArtifacts(command)
    console.log(JSON.stringify(result, null, 2))
    return true
  }
  if (command.kind === 'trace-export-otlp') {
    const { headersFilePath, ...rest } = command
    const fileHeaders = await loadHeadersFile(headersFilePath)
    const mergedHeaders = fileHeaders || rest.headers
      ? { ...(fileHeaders ?? {}), ...(rest.headers ?? {}) }
      : undefined
    const input: TraceExportOtlpInput = {
      ...rest,
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
    }
    const result = await exportTraceOtlp(input)
    console.log(JSON.stringify(result, null, 2))
    return true
  }
  if (command.kind === 'eval-score-session') {
    const result = await scoreSession(command)
    console.log(JSON.stringify({ scoresPath: result.scoresPath, summary: result.summary }, null, 2))
    return true
  }
  if (command.kind === 'eval-compare-runs') {
    const result = await compareEvalRuns(command)
    console.log(JSON.stringify({ comparisonPath: result.comparisonPath, comparison: result.comparison }, null, 2))
    return true
  }
  if (command.kind === 'eval-regression-gate') {
    const result = await evaluateRegressionGate(command)
    console.log(JSON.stringify({ verdictPath: result.verdictPath, verdict: result.verdict }, null, 2))
    if (!result.verdict.pass) {
      process.exitCode = 2
    }
    return true
  }
  if (command.kind === 'eval-judge-score') {
    const result = await judgeScore(command)
    console.log(JSON.stringify({ scoresPath: result.scoresPath, judgeTrace: result.judgeTrace, summary: result.summary }, null, 2))
    return true
  }
  if (command.kind === 'profile-session') {
    const result = await profileSession(command)
    console.log(JSON.stringify({ profilePath: result.profilePath, profile: result.profile }, null, 2))
    return true
  }
  if (command.kind === 'profile-aggregate') {
    const result = await aggregateProfiles(command)
    console.log(JSON.stringify({ reportPath: result.reportPath, report: result.report }, null, 2))
    return true
  }
  if (command.kind === 'profile-budget') {
    const result = await evaluateProfileBudget(command)
    console.log(JSON.stringify({ verdictPath: result.verdictPath, verdict: result.verdict }, null, 2))
    if (!result.verdict.pass) {
      process.exitCode = 2
    }
    return true
  }
  if (command.kind === 'reliability-audit-session') {
    const result = await auditSessionReliability(command)
    console.log(JSON.stringify({ auditPath: result.auditPath, audit: result.audit }, null, 2))
    return true
  }
  if (command.kind === 'reliability-chaos-replay') {
    const result = await replayReliabilityChaos(command)
    console.log(JSON.stringify({ reportPath: result.reportPath, report: result.report }, null, 2))
    return true
  }
  if (command.kind === 'reliability-gate') {
    const result = await evaluateReliabilityGate(command)
    console.log(JSON.stringify({ verdictPath: result.verdictPath, verdict: result.verdict }, null, 2))
    if (!result.verdict.pass) {
      process.exitCode = 2
    }
    return true
  }
  if (command.kind === 'reliability-classify') {
    const result = await classifyReliability(command)
    console.log(JSON.stringify({ reportPath: result.reportPath, report: result.report }, null, 2))
    return true
  }
  if (command.kind === 'tool-catalog-diff') {
    const result = await diffToolCatalogs(command)
    console.log(JSON.stringify({
      diffPath: result.diffPath,
      added: result.diff.added.length,
      removed: result.diff.removed.length,
      changed: result.diff.changed.length,
      unchanged: result.diff.unchanged.length,
    }, null, 2))
    return true
  }
  if (command.kind === 'executor-capabilities-snapshot') {
    const { readFile } = await import('node:fs/promises')
    const executors = command.executorsPath
      ? JSON.parse(await readFile(command.executorsPath, 'utf8'))
      : []
    if (!Array.isArray(executors)) {
      throw new Error(`executors file must contain a JSON array: ${command.executorsPath}`)
    }
    const result = await writeExecutorCapabilitySnapshot({
      rootDir: command.rootDir,
      ...(command.outputFilename ? { outputFilename: command.outputFilename } : {}),
      executors,
    })
    console.log(JSON.stringify({
      snapshotPath: result.snapshotPath,
      executorCount: result.snapshot.executorCount,
      summary: result.snapshot.summary,
    }, null, 2))
    return true
  }
  if (command.kind === 'memory-index') {
    const result = await buildMemoryIndex(command)
    console.log(JSON.stringify({ indexPath: result.indexPath, entries: result.index.entries.length, warnings: result.index.warnings }, null, 2))
    return true
  }
  if (command.kind === 'memory-retrieve') {
    const result = await retrieveMemory(command)
    console.log(JSON.stringify({
      artifactPath: result.artifactPath,
      hitCount: result.artifact.hitCount,
      usedTokens: result.artifact.budget.usedTokens,
      reasonCodes: result.artifact.reasonCodes,
      hits: result.artifact.hits.map((hit) => ({
        scope: hit.scope,
        key: hit.key,
        score: Number(hit.score.toFixed(4)),
        matchedTerms: hit.matchedTerms,
        estimatedTokens: hit.estimatedTokens,
      })),
    }, null, 2))
    return true
  }
  if (command.kind === 'subagents-graph') {
    const result = await exportSubAgentGraph(command)
    console.log(JSON.stringify({ graphPath: result.graphPath, nodes: result.graph.nodes.length, edges: result.graph.edges.length, warnings: result.graph.warnings }, null, 2))
    return true
  }
  if (command.kind === 'artifacts-manifest') {
    const result = await buildArtifactManifest(command)
    console.log(JSON.stringify({ manifestPath: result.manifestPath, summary: result.manifest.summary }, null, 2))
    return true
  }
  if (command.kind === 'artifacts-prune') {
    const result = await pruneArtifacts(command)
    console.log(JSON.stringify({
      reportPath: result.reportPath,
      dryRun: result.report.dryRun,
      before: result.report.before,
      after: result.report.after,
      removedCount: result.report.removed.length,
      protected: result.report.protected.length,
    }, null, 2))
    return true
  }
  if (command.kind === 'rollout-export-segments') {
    const result = await exportRolloutSegments(command)
    console.log(JSON.stringify({ artifact: result.artifact, segmentCount: result.segments.segments.length }, null, 2))
    return true
  }
  if (command.kind === 'rollout-export-adapter') {
    const result = await exportRolloutFrameworkAdapter(command)
    console.log(JSON.stringify({ adapterPath: result.adapterPath, status: result.adapter.status, frameworkTarget: result.adapter.frameworkTarget }, null, 2))
    return true
  }
  if (command.kind === 'rollout-verify-reward') {
    const result = await verifyReward(command)
    console.log(JSON.stringify({
      artifact: result.artifact,
      taskId: result.reward.taskId,
      reward: result.reward.reward,
      resolved: result.reward.resolved,
      shapedLabels: result.reward.shapedLabels,
      reasonCodes: result.reward.reasonCodes,
    }, null, 2))
    return true
  }
  if (command.kind === 'rl-validate-task-pool') {
    const result: TaskPoolValidation = await loadTaskPoolFile(command.taskFile, {
      trainingMode: command.trainingMode,
      ...(command.workspaceRoot ? { workspaceRoot: command.workspaceRoot } : {}),
    })
    console.log(JSON.stringify({ taskCount: result.taskCount, trainingAllowedCount: result.trainingAllowedCount, blockedCount: result.blockedCount, warnings: result.warnings }, null, 2))
    return true
  }
  if (command.kind === 'rl-write-token-capture-fixture') {
    const result = await writeTokenCaptureArtifact({
      rootDir: command.rootDir,
      requireLogprobs: command.requireLogprobs,
      capture: {
        rolloutId: command.rolloutId,
        sessionId: command.sessionId,
        callId: command.callId,
        provider: 'policy-gateway',
        backend: 'sglang',
        model: command.model,
        tokenizer: { nameOrPath: command.model, chatTemplate: 'fake-chat-template-v1' },
        promptIds: [151644, 872, 198],
        outputIds: [40, 686, 11273, 13],
        outputLogProbs: [-0.1, -0.2, -0.3, -0.4],
        responseMask: [1, 1, 1, 1],
        finishReason: 'stop',
        usage: { promptTokens: 3, completionTokens: 4 },
      },
    })
    const validation: TokenCaptureValidation = result.validation
    console.log(JSON.stringify({ artifact: result.artifact, validation }, null, 2))
    return true
  }
  if (command.kind === 'rl-build-trajectory') {
    const result = await buildTrajectory({
      rootDir: command.rootDir,
      rolloutId: command.rolloutId,
      taskId: command.taskId,
      sessionId: command.sessionId,
      tokenCapturePaths: command.tokenCaptures,
      ...(command.rewardPath ? { rewardPath: command.rewardPath } : {}),
    })
    console.log(JSON.stringify({ artifact: result.artifact, readiness: result.trajectory.readiness, turns: result.trajectory.turns.length }, null, 2))
    return true
  }
  if (command.kind === 'rl-validate-slime-sample') {
    const result = await validateSlimeSampleReadiness(command)
    console.log(JSON.stringify({ artifact: result.artifact, validation: result.validation }, null, 2))
    if (result.validation.status !== 'ready') process.exitCode = 2
    return true
  }
  if (command.kind === 'rl-run-rollout-smoke') {
    const pool = await loadTaskPoolFile(command.taskFile, { trainingMode: true, workspaceRoot: command.rootDir })
    const task = command.taskId
      ? pool.tasks.find((candidate) => candidate.taskId === command.taskId)
      : pool.tasks[0]
    if (!task) throw new Error(command.taskId ? `task not found: ${command.taskId}` : 'task pool has no tasks')
    const rolloutId = command.rolloutId ?? `rollout-cli-${Date.now()}`
    const llm = command.fixturePolicy
      ? fixturePolicyAdapter({ rootDir: command.rootDir, rolloutId, model: command.model, requireLogprobs: command.requireLogprobs })
      : policyGatewayFromCli(command, rolloutId)
    const result = await runRlRollout({
      rootDir: command.rootDir,
      task,
      llm,
      rolloutId,
      requireLogprobs: command.requireLogprobs,
      ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
    })
    console.log(JSON.stringify({ artifact: result.artifact, result: result.result }, null, 2))
    if (result.result.status !== 'completed' && result.result.readiness !== 'slime-sample-ready') process.exitCode = 2
    return true
  }
  if (command.kind === 'rl-inspect-rollout') {
    const result = JSON.parse(await readFile(command.rolloutPath, 'utf8')) as { readiness?: string; status?: string; blockedReason?: string; tokenCaptureRefs?: unknown[]; rewardRef?: unknown; trajectoryRef?: unknown; sampleValidationRef?: unknown }
    console.log(JSON.stringify({
      status: result.status ?? 'unknown',
      readiness: result.readiness ?? 'unknown',
      blockedReason: result.blockedReason,
      tokenCaptureCount: Array.isArray(result.tokenCaptureRefs) ? result.tokenCaptureRefs.length : 0,
      rewardPresent: Boolean(result.rewardRef),
      trajectoryPresent: Boolean(result.trajectoryRef),
      sampleValidationPresent: Boolean(result.sampleValidationRef),
    }, null, 2))
    return true
  }
  const result = await exportRolloutSidecar(command)
  console.log(JSON.stringify({
    rolloutId: result.sidecar.rollout_id,
    sidecarPath: result.sidecarPath,
    traceArtifact: result.traceArtifact,
  }, null, 2))
  return true
}

function policyGatewayFromCli(command: Extract<EnhancementCliCommand, { kind: 'rl-run-rollout-smoke' }>, rolloutId: string): LLMAdapter {
  if (!command.policyBaseUrl) throw new Error('rl run-rollout-smoke requires --policy-base-url or AGENT_KERNEL_POLICY_BASE_URL unless --fixture-policy is used')
  return policyGatewayAdapter({
    baseUrl: command.policyBaseUrl,
    artifactRoot: command.rootDir,
    model: command.model,
    ...(command.tokenizerPath ? { tokenizerPath: command.tokenizerPath } : {}),
    rolloutId,
    routeKey: rolloutId,
    requireLogprobs: command.requireLogprobs,
    ...(command.maxNewTokens !== undefined ? { maxNewTokens: command.maxNewTokens } : {}),
  })
}

function fixturePolicyAdapter(input: { rootDir: string; rolloutId: string; model: string; requireLogprobs: boolean }): LLMAdapter {
  return {
    name: 'fixture-policy:test-only',
    async call(params) {
      const { writeTokenCaptureArtifact } = await import('./rl/token-capture.js')
      const text = 'fixture policy response'
      await writeTokenCaptureArtifact({
        rootDir: input.rootDir,
        requireLogprobs: input.requireLogprobs,
        capture: {
          rolloutId: input.rolloutId,
          sessionId: 'fixture-session',
          callId: `fixture-${Date.now()}`,
          provider: 'policy-gateway',
          backend: 'sglang',
          model: input.model,
          tokenizer: { nameOrPath: input.model, chatTemplate: 'fixture-test-only' },
          promptIds: [1, 2, 3],
          outputIds: [4, 5, 6],
          outputLogProbs: [-0.1, -0.2, -0.3],
          responseMask: [1, 1, 1],
        },
      })
      return {
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        usage: { inputTokens: 3, outputTokens: 3 },
        trace: { provider: 'unknown', model: params.model ?? input.model, request: { url: 'fixture://policy', headers: {}, body: { fixture: true } }, response: { status: 200, body: { fixture: true } } },
      }
    },
  }
}

function value(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function required(argv: readonly string[], name: string): string {
  const found = value(argv, name)
  if (!found) throw new Error(`missing required ${name}`)
  return found
}

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

function numberValue(argv: readonly string[], name: string): number | undefined {
  const found = value(argv, name)
  if (found === undefined) return undefined
  const parsed = Number(found)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid numeric ${name}: ${found}`)
  return parsed
}

function listValue(argv: readonly string[], name: string): readonly string[] {
  const found = value(argv, name)
  if (!found) throw new Error(`missing required ${name}`)
  return found.split(',').map((item) => item.trim()).filter(Boolean)
}

function optionalListValue(argv: readonly string[], name: string): readonly string[] | undefined {
  const found = value(argv, name)
  if (!found) return undefined
  const items = found.split(',').map((item) => item.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

function frameworkTarget(value: string): ExportRolloutSidecarInput['frameworkTarget'] {
  if (value === 'slime' || value === 'verl' || value === 'trl' || value === 'openrlhf') return value
  return 'unknown'
}
