import { randomUUID } from 'node:crypto'

import { AgentBackendDescriptorSchema, canonicalJson, sha256Hex, type AgentVariantSpec, type NormalizedAgentEvent, type PreflightResult } from '@agent-kernel/eval-protocol'
import { AgentBackendTimeoutError, transientProviderError, type AgentBackendPlugin, type AgentRunArtifacts, type AgentRunHandle, type AgentRunInput, type EvaluationAgentBackend, type SandboxExecResult } from '@agent-kernel/eval-sdk'

type Running = {
  handle: AgentRunHandle
  input: AgentRunInput
  controller: AbortController
  done: Promise<SandboxExecResult>
  queue: AsyncQueue<NormalizedAgentEvent>
  nativeEvents: unknown[]
  normalizedEvents: NormalizedAgentEvent[]
  hostVersion: string
  executorVersion: string
  finalState?: Record<string, unknown>
}

const CREDENTIAL_ENVIRONMENT = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' } as const
const ACCEPTED_PROVIDERS = Object.keys(CREDENTIAL_ENVIRONMENT)

export class AgentRunLabBackend implements EvaluationAgentBackend {
  readonly descriptor = AgentBackendDescriptorSchema.parse({
    schemaVersion: 1, id: 'agent-runlab', label: 'Kala', version: '0.0.0', configSchemaVersion: 1, ranked: true, evidenceLevel: 'native',
    capabilities: { nonInteractive: true, workspaceInjection: true, isolatedConfig: true, cancellation: true, absoluteDeadline: true, nativeEvents: true, normalizedEvents: true, toolEvents: true, finalDiff: true, usage: 'available' },
  })
  private readonly runs = new Map<string, Running>()

  async preflight(config: AgentVariantSpec): Promise<PreflightResult> {
    const compatible = config.credentialRefs.filter((reference) => ACCEPTED_PROVIDERS.includes(reference.provider))
    const configuredProvider = string(config.config.provider) ?? config.model.provider
    const errors: Array<{ code: string; message: string }> = []
    if (compatible.length === 0) errors.push({ code: 'CREDENTIAL_REFERENCE_MISSING', message: 'Kala requires an openai or anthropic credential reference' })
    if (configuredProvider && !ACCEPTED_PROVIDERS.includes(configuredProvider)) errors.push({ code: 'PROVIDER_UNSUPPORTED', message: 'Kala provider must be openai or anthropic' })
    if (!configuredProvider && compatible.length > 1) errors.push({ code: 'PROVIDER_AMBIGUOUS', message: 'Kala config.provider is required when more than one compatible credential reference is declared' })
    if (configuredProvider && !compatible.some((reference) => reference.provider === configuredProvider)) errors.push({ code: 'PROVIDER_CREDENTIAL_MISMATCH', message: 'Kala has no credential reference for configured provider ' + configuredProvider })
    return { ok: errors.length === 0, errors, warnings: [{ code: 'SANDBOX_BINARY_PREFLIGHT_DEFERRED', message: 'Kala driver, Host, and Executor binaries are verified inside each fresh trial sandbox' }], resolvedVersion: this.descriptor.version, capabilities: this.descriptor.capabilities }
  }

  async start(input: AgentRunInput, signal: AbortSignal): Promise<AgentRunHandle> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason ?? new Error('Kala cancelled'))
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    const provider = selectedProvider(input.variant)
    const credentialEnvironment = mapCredential(input, provider)
    const baseEnvironment = { HOME: '/tmp/agent-runlab/home', TMPDIR: '/tmp', CI: '1', NO_COLOR: '1', ...credentialEnvironment }
    const [driver, host, executor] = await Promise.all([
      version(input, 'agent-eval-runlab-driver', baseEnvironment, controller.signal),
      version(input, 'agent-kernel-host', baseEnvironment, controller.signal),
      version(input, 'agent-kernel-executor', baseEnvironment, controller.signal),
    ])
    const handle: AgentRunHandle = { handleId: 'agent-runlab-' + randomUUID(), startedAt: new Date().toISOString(), nativeProcessIds: ['host', 'executor'] }
    const queue = new AsyncQueue<NormalizedAgentEvent>()
    const running: Running = { handle, input, controller, queue, nativeEvents: [], normalizedEvents: [], hostVersion: host, executorVersion: executor, done: Promise.resolve(undefined as never) }
    const started = { type: 'adapter.started', backendId: this.descriptor.id, handleId: handle.handleId, driverVersion: driver, hostVersion: host, executorVersion: executor }
    this.emit(running, started, handle.startedAt)
    const decoder = new JsonLineDecoder((native) => {
      if (record(native).type === 'runlab.state.changed') running.finalState = record(record(native).payload).state as Record<string, unknown> | undefined
      this.emit(running, native, new Date().toISOString())
    })
    const deadline = Math.max(1, Date.parse(input.absoluteDeadline) - Date.now())
    const config = input.variant.config
    const prompt = config.recoveryPolicy === 'observe-before-act'
      ? input.task.prompt + '\n\nRuntime recovery policy: before replaying or changing any operation after a failure, inspect the current observable state and ground the next action in that evidence. Preserve this observed-state check in the recovery evidence.\n'
      : input.task.prompt
    const args = [
      'agent-eval-runlab-driver',
      '--session-id', safeWireId(input.trialId),
      '--workspace', input.sandbox.workspacePath,
      '--model', input.variant.model.modelId,
      '--provider', provider,
      '--timeout-ms', String(deadline),
    ]
    running.done = input.sandbox.execute({
      argv: args, cwd: input.sandbox.workspacePath, stdin: prompt, timeoutMs: deadline,
      env: { ...baseEnvironment, ...(typeof config.baseUrl === 'string' ? { [provider === 'openai' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL']: config.baseUrl } : {}) },
      onStdout: (chunk) => decoder.write(chunk),
    }, controller.signal).then((result) => {
      decoder.end()
      if (result.timedOut) throw new AgentBackendTimeoutError('Kala exceeded its absolute deadline')
      if (result.exitCode !== 0) {
        const diagnostic = 'stdout tail:\n' + result.stdout.trim().slice(-4_000) + '\nstderr tail:\n' + result.stderr.trim().slice(-4_000)
        const providerError = transientProviderError(diagnostic, 'Kala provider request')
        if (providerError) throw providerError
        throw new Error('Kala driver exited with ' + String(result.exitCode) + ': ' + diagnostic)
      }
      queue.close(); return result
    }).catch((error: unknown) => { queue.close(error); throw error })
    void running.done.catch(() => undefined)
    this.runs.set(handle.handleId, running)
    return handle
  }

  async *events(handle: AgentRunHandle): AsyncIterable<NormalizedAgentEvent> { for await (const event of this.required(handle).queue) yield event }
  async cancel(handle: AgentRunHandle): Promise<void> { this.required(handle).controller.abort(new Error('Kala adapter cancelled')) }

  async collect(handle: AgentRunHandle): Promise<AgentRunArtifacts> {
    const run = this.required(handle)
    const result = await run.done
    const diff = await run.input.sandbox.execute({
      argv: ['bash', '-ceu', 'git diff --binary --no-ext-diff; while IFS= read -r -d "" file; do git diff --binary --no-index -- /dev/null "$file" || test "$?" -eq 1; done < <(git ls-files --others --exclude-standard -z)'],
      cwd: run.input.sandbox.workspacePath, timeoutMs: 30_000,
    }).catch(() => undefined)
    const usage = usageFromState(run.finalState)
    const finalResponse = finalResponseFromState(run.finalState)
    this.runs.delete(handle.handleId)
    return {
      completedAt: result.completedAt, ...(finalResponse ? { finalResponse } : {}), finalDiff: diff?.exitCode === 0 ? diff.stdout : '',
      nativeEvents: run.nativeEvents, normalizedEvents: run.normalizedEvents, stdout: result.stdout, stderr: result.stderr, usage,
      version: 'host=' + run.hostVersion + ';executor=' + run.executorVersion, configHash: run.input.variant.configHash,
      extraArtifactPaths: ['runlab-session.jsonl', 'runlab-native.tar'],
    }
  }

  private emit(run: Running, native: unknown, at: string): void {
    run.nativeEvents.push(native)
    const normalized = normalize(native, run.normalizedEvents.length, at, run.nativeEvents.length - 1)
    run.normalizedEvents.push(normalized); run.queue.push(normalized)
  }
  private required(handle: AgentRunHandle): Running { const run = this.runs.get(handle.handleId); if (!run) throw new Error('unknown Kala handle: ' + handle.handleId); return run }
}

function normalize(native: unknown, sequence: number, at: string, nativeIndex: number): NormalizedAgentEvent {
  const value = record(native); const type = string(value.type) ?? ''
  const payload = record(value.payload); const event = record(payload.event); const eventKind = string(event.kind) ?? ''
  const effects = Array.isArray(payload.effects) ? payload.effects.map(record) : []
  let kind: NormalizedAgentEvent['kind'] = 'status'
  if (type.includes('error') || eventKind === 'llm_error') kind = 'error'
  else if (eventKind === 'messages_replaced') kind = 'compaction'
  else if (eventKind === 'llm_response') kind = event.usage ? 'usage' : 'message'
  else if (eventKind === 'tool_result' || effects.some((effect) => effect.kind === 'call_tool')) kind = 'tool_call'
  else if (effects.some((effect) => effect.kind === 'call_llm')) kind = 'model_call'
  else if (eventKind === 'user_message') kind = 'message'
  if (effects.some((effect) => effect.name === 'agent')) kind = 'subagent'
  if (effects.some((effect) => effect.name === 'memory')) kind = 'memory'
  return { schemaVersion: 1, sequence, at, kind, nativeEventRef: 'native-events.jsonl#' + String(nativeIndex), data: value }
}

function selectedProvider(variant: AgentVariantSpec): keyof typeof CREDENTIAL_ENVIRONMENT {
  const configured = string(variant.config.provider) ?? variant.model.provider
  if (configured === 'openai' || configured === 'anthropic') return configured
  const providers = [...new Set(variant.credentialRefs.map((reference) => reference.provider).filter((provider) => ACCEPTED_PROVIDERS.includes(provider)))]
  if (providers.length !== 1) throw new Error('Kala provider is missing or ambiguous')
  return providers[0] as keyof typeof CREDENTIAL_ENVIRONMENT
}
function mapCredential(input: AgentRunInput, provider: keyof typeof CREDENTIAL_ENVIRONMENT): Readonly<Record<string, string>> {
  const references = input.variant.credentialRefs.filter((reference) => reference.provider === provider)
  if (references.length !== 1) throw new Error('Kala requires exactly one credential reference for ' + provider)
  const reference = references[0]!; const value = input.credentialValues[reference.referenceId]
  if (!value) throw new Error('resolved credential value is unavailable for reference: ' + reference.referenceId)
  return { [CREDENTIAL_ENVIRONMENT[provider]]: value }
}
async function version(input: AgentRunInput, binary: string, env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string> {
  const result = await input.sandbox.execute({ argv: [binary, '--version'], cwd: input.sandbox.workspacePath, env, timeoutMs: 10_000 }, signal)
  if (result.exitCode !== 0) throw new Error(binary + ' preflight failed: ' + result.stderr.slice(0, 500))
  return result.stdout.trim() || 'unknown'
}
function usageFromState(state: Record<string, unknown> | undefined): AgentRunArtifacts['usage'] {
  const usage = record(state?.usage); const inputTokens = number(usage.inputTokens); const outputTokens = number(usage.outputTokens)
  return inputTokens !== undefined && outputTokens !== undefined ? { availability: 'available', inputTokens, outputTokens } : { availability: 'unavailable', reason: 'Kala final state did not expose token usage' }
}
function finalResponseFromState(state: Record<string, unknown> | undefined): string | undefined {
  const messages = Array.isArray(state?.messages) ? state.messages : []
  for (const message of [...messages].reverse()) {
    const value = record(message); if (value.role !== 'assistant') continue
    const content = Array.isArray(value.content) ? value.content : []
    const text = content.map(record).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
    if (text) return text
  }
  return undefined
}
function safeWireId(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 120) || 'trial' }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined }

class JsonLineDecoder {
  private buffer = ''
  constructor(private readonly emit: (value: unknown) => void) {}
  write(chunk: string): void { this.buffer += chunk; while (true) { const index = this.buffer.indexOf('\n'); if (index < 0) return; this.decode(this.buffer.slice(0, index)); this.buffer = this.buffer.slice(index + 1) } }
  end(): void { if (this.buffer) this.decode(this.buffer); this.buffer = '' }
  private decode(line: string): void { if (!line) return; try { this.emit(JSON.parse(line)) } catch { this.emit({ type: 'runlab.stdout', text: line }) } }
}
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []; private readonly waiters: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = []; private ended = false; private error: unknown
  push(value: T): void { const waiter = this.waiters.shift(); if (waiter) waiter.resolve({ value, done: false }); else if (!this.ended) this.values.push(value) }
  close(error?: unknown): void { if (this.ended) return; this.ended = true; this.error = error; for (const waiter of this.waiters.splice(0)) error === undefined ? waiter.resolve({ value: undefined, done: true }) : waiter.reject(error) }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: async () => { const value = this.values.shift(); if (value !== undefined) return { value, done: false }; if (this.ended) { if (this.error !== undefined) throw this.error; return { value: undefined, done: true } }; return await new Promise((resolve, reject) => this.waiters.push({ resolve, reject })) } } }
}

export async function agentRunLabConfigHash(value: unknown): Promise<string> { return await sha256Hex(canonicalJson(value)) }
export function createAgentRunLabBackend(): AgentRunLabBackend { return new AgentRunLabBackend() }
export const evaluationPlugins: readonly AgentBackendPlugin[] = [{ kind: 'agent-backend', descriptor: createAgentRunLabBackend().descriptor, create: createAgentRunLabBackend }]
