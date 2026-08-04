import {
  EnvironmentLockSchema,
  decideFailureResponsibility,
  ResolvedTaskSchema,
  TrialResultCommitSchema,
  type AcceptedEvaluationRunSpec,
  type AgentVariantSpec,
  type TrialLease,
} from '@agent-kernel/eval-protocol'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AgentBackendTimeoutError, AgentProviderError, ControlPlaneClient, ControlPlaneHttpError, type AgentRunArtifacts, type AgentRunHandle, type ReferencedHashSigner, type SandboxExecutionTarget, type VerificationArtifacts } from '@agent-kernel/eval-sdk'

import { ArtifactStager } from './artifact-stager.js'
import { deriveAnalyzerInput } from './analyzer-input.js'
import { destroyAndVerify } from './cleanup.js'
import type { CredentialResolver } from './credentials.js'
import { supervise } from './process-supervisor.js'
import type { WorkerRuntimeRegistry } from './registry.js'
import { runVerifier } from './verifier-runner.js'
import { deriveTrialTrace } from './trace.js'

type RunProjectionResponse = { accepted: AcceptedEvaluationRunSpec; state: string }
type TrialProjectionResponse = { trialId: string; runId: string; taskId: string; agentVariantId: string; repeatIndex: number; state: string }

export class TrialRunner {
  private readonly stager: ArtifactStager
  private readonly seenSandboxIds = new Set<string>()

  constructor(private readonly options: {
    controlPlane: ControlPlaneClient
    registry: WorkerRuntimeRegistry
    credentials: CredentialResolver
    artifactRoot: string
    workerDataDir: string
    signingProvider: ReferencedHashSigner
    now?: () => Date
    cancellationGraceMs?: number
  }) {
    this.stager = new ArtifactStager(options.artifactRoot, options.signingProvider)
  }

  async run(lease: TrialLease, signal?: AbortSignal, lifecycle?: { executionReceipt(receipt: 'indeterminate' | 'known'): Promise<void>; progress(state: 'environment_preparing' | 'agent_running' | 'artifacts_collecting' | 'verifying' | 'analyzing'): Promise<void> }): Promise<void> {
    const now = this.options.now ?? (() => new Date())
    let target: SandboxExecutionTarget | undefined
    let phase: 'environment' | 'agent' | 'verifier' | 'artifacts' = 'environment'
    let cleanupCompleted = false
    let credentialValues: readonly string[] = []
    let liveHandle: AgentRunHandle | undefined
    let cancellation: Promise<void> | undefined
    const trialStartedAt = now().toISOString()
    try {
      const run = await this.options.controlPlane.query({ resource: 'run', runId: lease.runId }, signal) as RunProjectionResponse
      if (!run) throw new ClassifiedTrialError('environment_error', 'RUN_NOT_FOUND', 'lease run is not available')
      if (run.accepted.specHash !== lease.specHash) throw new ClassifiedTrialError('environment_error', 'SPEC_HASH_MISMATCH', 'lease spec hash does not match accepted run')
      const trial = await this.options.controlPlane.query({ resource: 'trial', trialId: lease.trialId }, signal) as TrialProjectionResponse
      if (!trial) throw new ClassifiedTrialError('environment_error', 'TRIAL_NOT_FOUND', 'lease trial is not available')
      const task = ResolvedTaskSchema.parse(await this.options.controlPlane.query({ resource: 'task', taskId: trial.taskId }, signal))
      const variant = requiredVariant(run.accepted.spec.agents, trial.agentVariantId)
      if (task.requiredSandboxImageDigest && task.requiredSandboxImageDigest !== run.accepted.spec.sandbox.imageDigest) {
        throw new ClassifiedTrialError('blocked', 'TASK_IMAGE_MISMATCH', 'run sandbox image does not match the task-pinned image')
      }
      const provider = this.options.registry.sandbox(run.accepted.spec.sandbox.provider)
      const backend = this.options.registry.agent(variant)
      const benchmark = this.options.registry.benchmark(task)
      const [sandboxPreflight, agentPreflight] = await Promise.all([provider.preflight(run.accepted.spec.sandbox), backend.preflight(variant)])
      if (!sandboxPreflight.ok) throw new ClassifiedTrialError('blocked', 'SANDBOX_PREFLIGHT', sandboxPreflight.errors.map((error) => error.code).join(','))
      if (!agentPreflight.ok) throw new ClassifiedTrialError('blocked', 'AGENT_PREFLIGHT', agentPreflight.errors.map((error) => error.code).join(','))
      const credentials = await this.options.credentials.resolve(variant.credentialRefs, signal)
      credentialValues = Object.values(credentials)
      await lifecycle?.progress('environment_preparing')
      const environmentStartedAt = now().toISOString()
      target = await provider.create({ workerId: lease.workerId, trialId: trial.trialId, task, policy: run.accepted.spec.sandbox, workerDataDir: this.options.workerDataDir })
      if (this.seenSandboxIds.has(target.sandboxId)) throw new ClassifiedTrialError('environment_error', 'SANDBOX_REUSED', 'provider reused a sandbox identity across trials')
      this.seenSandboxIds.add(target.sandboxId)
      await benchmark.prepareTask(task, target)
      const workspaceBefore = await target.snapshot()
      const environmentCompletedAt = now().toISOString()
      const cancelLiveHandle = async (): Promise<void> => {
        if (!liveHandle) return
        cancellation ??= backend.cancel(liveHandle)
        await cancellation
      }
      const supervised = await supervise({
        timeoutMs: run.accepted.spec.execution.timeoutMs,
        cancellationGraceMs: this.options.cancellationGraceMs,
        signal,
        operation: async (trialSignal) => {
          await lifecycle?.progress('agent_running')
          await lifecycle?.executionReceipt('indeterminate')
          phase = 'agent'
          liveHandle = await backend.start({
            runId: lease.runId,
            trialId: lease.trialId,
            task,
            variant,
            sandbox: target!,
            credentialValues: credentials,
            absoluteDeadline: new Date(now().getTime() + run.accepted.spec.execution.timeoutMs).toISOString(),
            inactivityTimeoutMs: run.accepted.spec.execution.inactivityTimeoutMs,
          }, trialSignal)
          await lifecycle?.executionReceipt('known')
          try {
            await consumeEvents(backend.events(liveHandle), run.accepted.spec.execution.inactivityTimeoutMs, trialSignal)
          } catch (error) {
            await cancelLiveHandle()
            throw error
          }
          const agentArtifacts = await backend.collect(liveHandle)
          return agentArtifacts
        },
        onCancel: async () => {
          await cancelLiveHandle()
        },
      })
      if (supervised.status !== 'completed') throw new ClassifiedTrialError(supervised.status, supervised.status === 'timeout' ? 'ABSOLUTE_TIMEOUT' : 'CANCELLED', supervised.error.message)
      phase = 'artifacts'
      await lifecycle?.progress('artifacts_collecting')
      const agentArtifacts = supervised.value as AgentRunArtifacts
      const agentStartedAt = liveHandle?.startedAt ?? trialStartedAt
      const agentCompletedAt = agentArtifacts.completedAt
      const workspaceAfter = await target.snapshot()
      phase = 'verifier'
      await lifecycle?.progress('verifying')
      const verifierStartedAt = now().toISOString()
      const verificationDeadline = await supervise({
        timeoutMs: run.accepted.spec.verification.timeoutMs,
        cancellationGraceMs: this.options.cancellationGraceMs,
        signal,
        operation: async (verifierSignal) => await runVerifier({ adapter: benchmark, runId: lease.runId, trialId: lease.trialId, task, sandbox: target!, agentArtifacts, agentVariant: variant, signal: verifierSignal }),
      })
      if (verificationDeadline.status !== 'completed') {
        if (verificationDeadline.status === 'timeout') throw new ClassifiedTrialError('timeout', 'VERIFIER_TIMEOUT', verificationDeadline.error.message)
        throw new ClassifiedTrialError('cancelled', 'CANCELLED', verificationDeadline.error.message)
      }
      const verification = verificationDeadline.value
      const verifierCompletedAt = now().toISOString()
      phase = 'artifacts'
      const collected = await provider.collect(target)
      const environmentLock = EnvironmentLockSchema.parse(collected.environmentLock)
      await lifecycle?.progress('analyzing')
      const evidencePrefix = lease.runId + '/' + lease.trialId + '/'
      const trace = deriveTrialTrace({ runId: lease.runId, trialId: lease.trialId, backendId: variant.backendId, taskId: task.taskId, trialStartedAt, environmentStartedAt, environmentCompletedAt, agentStartedAt, agentCompletedAt, verifierStartedAt, verifierCompletedAt, workspaceBefore, workspaceAfter, events: agentArtifacts.normalizedEvents })
      const analyzerInput = await deriveAnalyzerInput({ runId: lease.runId, trialId: lease.trialId, task, events: agentArtifacts.normalizedEvents, nativeEvents: agentArtifacts.nativeEvents, normalizationVersion: agentArtifacts.version, trace, finalDiff: agentArtifacts.finalDiff, verifier: verification.result })
      const staged = await this.stager.stage({
        runId: lease.runId,
        trialId: lease.trialId,
        leaseId: lease.leaseId,
        agentArtifacts,
        verification,
        analyzerInput,
        trace,
        workspaceBefore,
        workspaceAfter,
        evidence: {
          schemaVersion: 1,
          runId: lease.runId,
          trialId: lease.trialId,
          agentVariantId: variant.variantId,
          taskId: task.taskId,
          repeatIndex: trial.repeatIndex,
          environmentLock,
          nativeEventsRef: evidencePrefix + 'native-events.jsonl',
          normalizedEventsRef: evidencePrefix + 'normalized-events.jsonl',
          traceRef: evidencePrefix + 'trace.jsonl',
          normalizedEventCount: agentArtifacts.normalizedEvents.length,
          analyzerInputRef: evidencePrefix + 'analyzer-input.json',
          finalDiffRef: evidencePrefix + 'final.diff',
          stdoutRef: evidencePrefix + 'stdout.log',
          stderrRef: evidencePrefix + 'stderr.log',
          usage: agentArtifacts.usage,
          benchmarkResult: { ...verification.result, rawResultRef: evidencePrefix + 'verifier-result.json' },
          evidenceLevel: backend.descriptor.ranked && verification.result.officialEvidence ? 'official' : backend.descriptor.evidenceLevel,
        },
        secrets: credentialValues,
        importedArtifacts: {
          root: collected.artifactRoot,
          paths: [...agentArtifacts.extraArtifactPaths, ...verification.artifactPaths],
          allowlist: run.accepted.spec.sandbox.artifactAllowlist.map((path) => path.replaceAll('{taskPackId}', task.taskPackId).replaceAll('{trialId}', lease.trialId)),
        },
      })
      await this.stager.verify(staged)
      await this.uploadArtifacts(lease, staged.artifactManifest.entries, signal)
      await destroyAndVerify(provider, target)
      cleanupCompleted = true
      await retryTransport(() => this.options.controlPlane.commitTrialResult(TrialResultCommitSchema.parse({
        schemaVersion: 1, leaseId: lease.leaseId, trialId: lease.trialId, attempt: lease.attempt,
        commitToken: lease.commitToken, resultHash: staged.resultHash, artifactManifestHash: staged.artifactManifestHash, evidence: staged.evidence,
        resourceUsage: {
          inputTokens: agentArtifacts.usage.availability === 'available' ? agentArtifacts.usage.inputTokens : 0,
          outputTokens: agentArtifacts.usage.availability === 'available' ? agentArtifacts.usage.outputTokens : 0,
          costUsd: agentArtifacts.usage.availability === 'available' ? agentArtifacts.usage.costUsd ?? 0 : 0,
          wallMs: Math.max(0, Date.parse(agentArtifacts.completedAt) - Date.parse(liveHandle?.startedAt ?? agentArtifacts.completedAt)),
        },
        terminalState: 'completed', committedAt: now().toISOString(),
      })), signal)
    } catch (error) {
      if (target && !cleanupCompleted) {
        const provider = this.options.registry.sandbox(target.descriptor.kind)
        try { await destroyAndVerify(provider, target); cleanupCompleted = true } catch (cleanupError) {
          error = new ClassifiedTrialError('environment_error', 'CLEANUP_FAILED', message(cleanupError))
        }
      }
      const classified = classify(error, phase)
      const at = now().toISOString()
      const failure = normalizedFailure(classified, lease.trialId)
      const staged = await this.stager.stageFailure({ runId: lease.runId, trialId: lease.trialId, leaseId: lease.leaseId, at, state: classified.state, code: classified.code, message: classified.message, failure, secrets: credentialValues })
      await this.stager.verify(staged)
      await this.uploadArtifacts(lease, staged.artifactManifest.entries, signal)
      await retryTransport(() => this.options.controlPlane.commitTrialResult({
        schemaVersion: 1, leaseId: lease.leaseId, trialId: lease.trialId, attempt: lease.attempt,
        commitToken: lease.commitToken, resultHash: staged.resultHash, artifactManifestHash: staged.artifactManifestHash,
        failure, terminalState: classified.state, committedAt: at,
      }), signal)
    }
  }

  private async uploadArtifacts(lease: TrialLease, entries: readonly import('@agent-kernel/eval-protocol').ArtifactEntry[], signal?: AbortSignal): Promise<void> {
    for (const entry of entries) {
      const content = await readFile(resolve(this.options.artifactRoot, entry.path))
      await retryTransport(() => this.options.controlPlane.stageTrialArtifact({ leaseId: lease.leaseId, commitToken: lease.commitToken, path: entry.path, mediaType: entry.mediaType, bytes: entry.bytes, sha256: entry.sha256, content }, signal), signal)
    }
  }
}

class ClassifiedTrialError extends Error {
  constructor(readonly state: 'blocked' | 'timeout' | 'cancelled' | 'agent_error' | 'environment_error' | 'verifier_error' | 'indeterminate', readonly code: string, message: string) { super(message) }
}

function requiredVariant(variants: readonly AgentVariantSpec[], id: string): AgentVariantSpec {
  const variant = variants.find((candidate) => candidate.variantId === id)
  if (!variant) throw new ClassifiedTrialError('environment_error', 'VARIANT_NOT_FOUND', 'trial Agent variant is not in accepted spec')
  return variant
}

function classify(error: unknown, phase: 'environment' | 'agent' | 'verifier' | 'artifacts'): ClassifiedTrialError {
  if (error instanceof ClassifiedTrialError) return error
  if (error instanceof AgentProviderError) return new ClassifiedTrialError('agent_error', error.code, error.message)
  if (error instanceof AgentBackendTimeoutError) return new ClassifiedTrialError('timeout', error.code, error.message)
  if (resourceExhaustion(error)) return new ClassifiedTrialError('environment_error', 'RESOURCE_EXHAUSTED', message(error))
  if (phase === 'artifacts') return new ClassifiedTrialError('environment_error', 'ARTIFACT_ERROR', message(error))
  if (phase === 'verifier') return new ClassifiedTrialError('verifier_error', 'VERIFIER_ERROR', message(error))
  if (phase === 'agent') return new ClassifiedTrialError('agent_error', 'AGENT_ERROR', message(error))
  return new ClassifiedTrialError('environment_error', 'ENVIRONMENT_ERROR', message(error))
}

async function retryTransport<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('operation cancelled')
    try { return await operation() } catch (error) {
      if (!transientTransport(error) || attempt === 3) throw error
      lastError = error
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
        const timer = setTimeout(finish, attempt * 25)
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason instanceof Error ? signal.reason : new Error('operation cancelled')) }
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
  }
  throw lastError
}

function transientTransport(error: unknown): boolean {
  if (error instanceof ControlPlaneHttpError) return error.status === 408 || error.status === 429 || error.status >= 500
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(code)
}

function resourceExhaustion(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOSPC' || code === 'EDQUOT' || /no space left|disk quota|out of memory|oom killed|resource exhausted/iu.test(message(error))
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function normalizedFailure(error: ClassifiedTrialError, trialId: string): import('@agent-kernel/eval-protocol').NormalizedFailure {
  const mapping: Record<ClassifiedTrialError['state'], { category: import('@agent-kernel/eval-protocol').FailureCategory; origin: import('@agent-kernel/eval-protocol').ResponsibilityDecisionInput['origin']; retryRequested: boolean }> = {
    blocked: { category: 'unmet_precondition', origin: 'platform', retryRequested: false },
    timeout: { category: 'timeout', origin: error.code.includes('VERIFIER') ? 'verifier' : error.code.includes('PROVIDER') ? 'provider' : error.code.includes('AGENT') || error.code.includes('INACTIVITY') ? 'agent' : 'platform', retryRequested: true },
    cancelled: { category: 'cancelled', origin: 'operator', retryRequested: false },
    agent_error: { category: error.code.includes('PROVIDER') ? 'provider_failure' : 'agent_failure', origin: error.code.includes('PROVIDER') ? 'provider' : 'agent', retryRequested: error.code.includes('PROVIDER') },
    environment_error: { category: 'environment_failure', origin: 'environment', retryRequested: error.code !== 'CLEANUP_FAILED' },
    verifier_error: { category: 'verifier_failure', origin: 'verifier', retryRequested: true },
    indeterminate: { category: 'indeterminate_side_effect', origin: 'unknown', retryRequested: false },
  }
  const selected = mapping[error.state]
  const observedStateSufficientForRecovery = error.state !== 'indeterminate' && error.code !== 'CLEANUP_FAILED'
  const decision = decideFailureResponsibility({ ...selected, observedStateSufficientForRecovery, sideEffectMayHaveOccurred: error.state === 'indeterminate' })
  return { schemaVersion: 1, ...decision, code: error.code, summary: error.message, evidenceRefs: ['trial:' + trialId + '/failure.json'] }
}

async function consumeEvents(events: AsyncIterable<unknown>, inactivityTimeoutMs: number, signal: AbortSignal): Promise<void> {
  const iterator = events[Symbol.asyncIterator]()
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const inactivity = new Promise<{ type: 'inactivity' }>((resolve) => {
      timer = setTimeout(() => resolve({ type: 'inactivity' }), inactivityTimeoutMs)
      timer.unref()
    })
    const aborted = new Promise<{ type: 'aborted' }>((resolve) => {
      abortListener = () => resolve({ type: 'aborted' })
      signal.addEventListener('abort', abortListener, { once: true })
      if (signal.aborted) abortListener()
    })
    try {
      const result = await Promise.race([iterator.next().then((value) => ({ type: 'event' as const, value })), inactivity, aborted])
      if (result.type === 'inactivity') throw new ClassifiedTrialError('timeout', 'INACTIVITY_TIMEOUT', 'Agent event stream exceeded inactivity timeout')
      if (result.type === 'aborted') throw signal.reason instanceof Error ? signal.reason : new Error('Agent execution cancelled')
      if (result.value.done) return
    } finally {
      if (timer) clearTimeout(timer)
      if (abortListener) signal.removeEventListener('abort', abortListener)
    }
  }
}
