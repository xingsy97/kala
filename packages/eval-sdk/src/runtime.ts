import type {
  AgentBackendDescriptor,
  AgentVariantSpec,
  ArtifactManifest,
  BenchmarkNativeResult,
  EnvironmentLock,
  NormalizedAgentEvent,
  PreflightResult,
  NormalizedFailure,
  ResolvedTask,
  SandboxDescriptor,
  SandboxPolicy,
  UsageEvidence,
} from '@agent-kernel/eval-protocol'

export type SandboxExecRequest = {
  argv: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
  stdin?: string
  timeoutMs: number
  /** Live process output. Callbacks are observational and are never persisted by the sandbox provider. */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export type SandboxExecResult = {
  exitCode: number | null
  signal?: string
  stdout: string
  stderr: string
  startedAt: string
  completedAt: string
  timedOut: boolean
}

export type SandboxSnapshot = {
  snapshotId: string
  createdAt: string
  manifestHash: string
  files: readonly { path: string; bytes: number; sha256: string }[]
}

export interface SandboxExecutionTarget {
  readonly sandboxId: string
  readonly descriptor: SandboxDescriptor
  readonly workspacePath: string
  execute(request: SandboxExecRequest, signal?: AbortSignal): Promise<SandboxExecResult>
  putArchive(archivePath: string, destination: string): Promise<void>
  getArchive(source: string, archivePath: string): Promise<void>
  snapshot(): Promise<SandboxSnapshot>
}

export type SandboxCreateInput = {
  workerId: string
  trialId: string
  task: ResolvedTask
  policy: SandboxPolicy
  workerDataDir: string
}

export type SandboxCollectedArtifacts = {
  environmentLock: EnvironmentLock
  artifactRoot: string
  cleanupEvidence: Readonly<Record<string, unknown>>
}

export interface EvaluationSandboxProvider {
  readonly descriptor: SandboxDescriptor
  preflight(policy: SandboxPolicy): Promise<PreflightResult>
  create(input: SandboxCreateInput): Promise<SandboxExecutionTarget>
  collect(target: SandboxExecutionTarget): Promise<SandboxCollectedArtifacts>
  destroy(target: SandboxExecutionTarget): Promise<void>
  verifyDestroyed(target: SandboxExecutionTarget): Promise<boolean>
  /** Remove only instances explicitly labelled as owned by this Worker from an earlier process lifetime. */
  reapOrphans(workerId: string): Promise<readonly string[]>
}

export type AgentRunInput = {
  runId: string
  trialId: string
  task: ResolvedTask
  variant: AgentVariantSpec
  sandbox: SandboxExecutionTarget
  /** Secret values keyed by credential reference id. Backends map only declared providers to an explicit environment allowlist. */
  credentialValues: Readonly<Record<string, string>>
  absoluteDeadline: string
  inactivityTimeoutMs: number
}

export type AgentRunHandle = {
  handleId: string
  startedAt: string
  nativeProcessIds: readonly string[]
}

export type AgentRunArtifacts = {
  completedAt: string
  finalResponse?: string
  finalDiff: string
  nativeEvents: readonly unknown[]
  normalizedEvents: readonly NormalizedAgentEvent[]
  stdout: string
  stderr: string
  usage: UsageEvidence
  version: string
  configHash: string
  extraArtifactPaths: readonly string[]
}

/** Raised when an Agent process reaches the absolute deadline enforced by its trial sandbox. */
export class AgentBackendTimeoutError extends Error {
  readonly code = 'AGENT_BACKEND_TIMEOUT'
  constructor(message: string) { super(message); this.name = 'AgentBackendTimeoutError' }
}

export type AgentProviderFailureKind = 'rate_limited' | 'timeout' | 'unavailable'

/** Raised when an Agent CLI reports a transient upstream model-provider failure. */
export class AgentProviderError extends Error {
  readonly code: 'PROVIDER_RATE_LIMIT' | 'PROVIDER_TIMEOUT' | 'PROVIDER_UNAVAILABLE'
  constructor(readonly kind: AgentProviderFailureKind, message: string) {
    super(message)
    this.name = 'AgentProviderError'
    this.code = kind === 'rate_limited' ? 'PROVIDER_RATE_LIMIT' : kind === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE'
  }
}

/** Convert only recognizable transient provider diagnostics; ordinary Agent failures remain ordinary errors. */
export function transientProviderError(diagnostic: string, label = 'Agent provider request'): AgentProviderError | undefined {
  const normalized = diagnostic.toLowerCase()
  if (/\b429\b|rate[_ -]?limit|too many requests/u.test(normalized)) return new AgentProviderError('rate_limited', label + ' was rate limited')
  if (/\b(?:etimedout|esockettimedout)\b|request timed out|upstream timeout|provider timeout/u.test(normalized)) return new AgentProviderError('timeout', label + ' timed out')
  if (/\b(?:502|503|504|econnreset|econnrefused)\b|service unavailable|provider unavailable|temporarily unavailable|overloaded/u.test(normalized)) return new AgentProviderError('unavailable', label + ' was unavailable')
  return undefined
}

export interface EvaluationAgentBackend {
  readonly descriptor: AgentBackendDescriptor
  preflight(config: AgentVariantSpec): Promise<PreflightResult>
  start(input: AgentRunInput, signal: AbortSignal): Promise<AgentRunHandle>
  events(handle: AgentRunHandle): AsyncIterable<NormalizedAgentEvent>
  cancel(handle: AgentRunHandle): Promise<void>
  collect(handle: AgentRunHandle): Promise<AgentRunArtifacts>
}

export type VerificationInput = {
  runId: string
  trialId: string
  task: ResolvedTask
  sandbox: SandboxExecutionTarget
  agentArtifacts: AgentRunArtifacts
  agentVariant: AgentVariantSpec
  signal: AbortSignal
}

export type VerificationArtifacts = {
  result: BenchmarkNativeResult
  stdout: string
  stderr: string
  artifactPaths: readonly string[]
}

export interface EvaluationBenchmarkAdapter {
  readonly descriptor: import('@agent-kernel/eval-protocol').BenchmarkDescriptor
  resolveTasks(input: unknown): Promise<readonly ResolvedTask[]>
  prepareTask(task: ResolvedTask, sandbox: SandboxExecutionTarget): Promise<void>
  verify(input: VerificationInput): Promise<VerificationArtifacts>
  explain(result: import('@agent-kernel/eval-protocol').BenchmarkNativeResult): Readonly<Record<string, unknown>>
  normalizeFailure(result: import('@agent-kernel/eval-protocol').BenchmarkNativeResult): NormalizedFailure | null
}

export type StagedTrialEvidence = {
  artifactManifest: ArtifactManifest
  evidence?: import('@agent-kernel/eval-protocol').TrialEvidence
  resultHash: string
  artifactManifestHash: string
  root: string
}
