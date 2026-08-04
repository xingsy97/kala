import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

import {
  CounterfactualContinuationRequestSchema, CounterfactualResultSchema, NormalizedAgentEventSchema, canonicalJson,
  counterfactualFailureFingerprint,
  type AnalyzerInput, type CounterfactualContinuationRequest, type CounterfactualIntervention, type CounterfactualResult,
  type NormalizedAgentEvent,
} from '@agent-kernel/eval-protocol'

export type CounterfactualContinuationObservation = {
  continuationEvents: NormalizedAgentEvent[]
}

export type CounterfactualOutcomeVerifier = {
  verify(input: { source: AnalyzerInput; checkpoint: readonly NormalizedAgentEvent[]; intervention: CounterfactualIntervention; continuationEvents: readonly NormalizedAgentEvent[]; signal?: AbortSignal }): Promise<{ passed: boolean; infrastructureError?: boolean; evidenceRefs: readonly string[] }>
}

export type CounterfactualContinuationHarness = {
  continue(input: {
    source: AnalyzerInput
    checkpoint: readonly NormalizedAgentEvent[]
    checkpointHash: string
    intervention: CounterfactualIntervention
    signal?: AbortSignal
  }): Promise<CounterfactualContinuationObservation>
}

export class CommandCounterfactualContinuationHarness implements CounterfactualContinuationHarness {
  constructor(private readonly argv: readonly [string, ...string[]], private readonly timeoutMs = 300_000) {}

  async continue(input: Parameters<CounterfactualContinuationHarness['continue']>[0]): Promise<CounterfactualContinuationObservation> {
    const output = await executeJsonCommand(this.argv, {
      schemaVersion: 1, source: input.source, checkpoint: input.checkpoint, checkpointHash: input.checkpointHash, intervention: input.intervention,
    }, this.timeoutMs, input.signal)
    return parseObservation(output)
  }
}

export async function continueCounterfactual(
  requestInput: CounterfactualContinuationRequest,
  source: AnalyzerInput,
  harness: CounterfactualContinuationHarness,
  verifier: CounterfactualOutcomeVerifier,
  signal?: AbortSignal,
): Promise<CounterfactualResult[]> {
  const request = CounterfactualContinuationRequestSchema.parse(requestInput)
  if (source.trialId !== request.sourceTrialId) throw new Error('counterfactual source trial does not match immutable request')
  if (request.checkpointSequence >= source.events.length) throw new Error('counterfactual checkpoint is outside the source trace')
  if (source.verifierIntegrity.passed) throw new Error('counterfactual continuation requires a failed source trial')
  if (await counterfactualFailureFingerprint(source.events, request.checkpointSequence) !== request.sourceFailureFingerprint) throw new Error('counterfactual source failure fingerprint mismatch')
  const checkpoint = source.events.slice(0, request.checkpointSequence + 1)
  const checkpointHash = hash(canonicalJson(checkpoint))
  const results: CounterfactualResult[] = []
  for (const intervention of request.interventions) {
    validateIntervention(intervention, checkpoint)
    const observation = await harness.continue({ source, checkpoint, checkpointHash, intervention, signal })
    validateContinuation(observation.continuationEvents, request.checkpointSequence)
    const verifierResult = await verifier.verify({ source, checkpoint, intervention, continuationEvents: observation.continuationEvents, signal })
    if (verifierResult.evidenceRefs.length === 0 || verifierResult.evidenceRefs.some((ref) => !ref.trim())) throw new Error('counterfactual verifier returned invalid evidence refs')
    const verification = { passed: verifierResult.passed, ...(verifierResult.infrastructureError ? { infrastructureError: true } : {}), evidenceRefs: [...verifierResult.evidenceRefs] }
    const observedFailureFingerprint = verification.passed || verification.infrastructureError ? undefined : await counterfactualFailureFingerprint([...checkpoint, ...observation.continuationEvents], request.checkpointSequence)
    const outcome: CounterfactualResult['outcome'] = verification.infrastructureError ? 'infrastructure_error' : verification.passed ? 'resolved' : observedFailureFingerprint === request.sourceFailureFingerprint ? 'same_failure' : 'different_failure'
    const unsigned = {
      schemaVersion: 1 as const, counterfactualId: request.requestId + '-' + intervention.kind,
      sourceTrialId: source.trialId, checkpointSequence: request.checkpointSequence, intervention: intervention.kind,
      checkpointHash, outcome,
      ...(observedFailureFingerprint ? { observedFailureFingerprint } : {}),
      evidenceRefs: verification.evidenceRefs, continuationEvents: observation.continuationEvents,
    }
    const continuationHash = hash(canonicalJson({ checkpointHash, intervention, continuationEvents: observation.continuationEvents, verification }))
    results.push(CounterfactualResultSchema.parse({ ...unsigned, continuationHash }))
  }
  return results
}

function validateIntervention(intervention: CounterfactualIntervention, checkpoint: readonly NormalizedAgentEvent[]): void {
  if (intervention.kind !== 'corrected_tool_result') return
  const toolCall = checkpoint.find((event) => event.sequence === intervention.toolCallSequence)
  if (!toolCall || toolCall.kind !== 'tool_call') throw new Error('corrected tool result must reference a tool call in the checkpoint')
}

function validateContinuation(events: readonly NormalizedAgentEvent[], checkpointSequence: number): void {
  for (const [index, event] of events.entries()) {
    const expected = checkpointSequence + index + 1
    if (event.sequence !== expected) throw new Error('counterfactual continuation events must resume contiguously after the checkpoint')
  }
}

function parseObservation(value: unknown): CounterfactualContinuationObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('counterfactual harness returned a non-object observation')
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.continuationEvents)) throw new Error('counterfactual harness returned invalid continuation events')
  return { continuationEvents: record.continuationEvents.map((event) => NormalizedAgentEventSchema.parse(event)) }
}

const HARNESS_ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR'])
const HARNESS_OUTPUT_LIMIT = 1024 * 1024
const HARNESS_KILL_GRACE_MS = 1_000

async function executeJsonCommand(argv: readonly [string, ...string[]], value: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  return await new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, entry]) => HARNESS_ENV_ALLOWLIST.has(name) && entry !== undefined))
    const useProcessGroup = process.platform !== 'win32'
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env, detached: useProcessGroup })
    const stdout: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0; let settled = false
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try { if (useProcessGroup && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch { child.kill('SIGTERM') }
      const killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try { if (useProcessGroup && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { child.kill('SIGKILL') }
      }, HARNESS_KILL_GRACE_MS)
      killTimer.unref()
    }
    const finish = (error?: Error, output?: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) reject(error); else resolve(output)
    }
    const abort = () => { terminate(); finish(signal?.reason instanceof Error ? signal.reason : new Error('counterfactual harness aborted')) }
    const timer = setTimeout(() => { terminate(); finish(new Error('counterfactual harness timed out')) }, timeoutMs)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > HARNESS_OUTPUT_LIMIT) { terminate(); finish(new Error('counterfactual harness stdout exceeded limit')); return }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > HARNESS_OUTPUT_LIMIT) { terminate(); finish(new Error('counterfactual harness stderr exceeded limit')) }
    })
    child.stdin.on('error', () => undefined)
    child.once('error', (error) => finish(new Error('counterfactual harness could not be started', { cause: error })))
    child.once('close', (code) => {
      if (code !== 0) { finish(new Error('counterfactual harness exited with code ' + String(code))); return }
      try { finish(undefined, JSON.parse(Buffer.concat(stdout).toString('utf8'))) } catch { finish(new Error('counterfactual harness returned invalid JSON')) }
    })
    child.stdin.end(canonicalJson(value))
  })
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
