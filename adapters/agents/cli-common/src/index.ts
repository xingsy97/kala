import { randomUUID } from 'node:crypto'

import { canonicalJson, sha256Hex, type AgentBackendDescriptor, type NormalizedAgentEvent, type PreflightResult } from '@agent-kernel/eval-protocol'
import { AgentBackendTimeoutError, transientProviderError, type AgentRunArtifacts, type AgentRunHandle, type AgentRunInput, type EvaluationAgentBackend, type SandboxExecResult } from '@agent-kernel/eval-sdk'

type Running = { handle: AgentRunHandle; input: AgentRunInput; controller: AbortController; done: Promise<SandboxExecResult>; eventQueue: AsyncQueue<NormalizedAgentEvent>; events: NormalizedAgentEvent[]; native: unknown[]; version: string; configHash: string; finalResponsePath?: string }

export abstract class StructuredCliAgentBackend implements EvaluationAgentBackend {
  abstract readonly descriptor: AgentBackendDescriptor
  private readonly runs = new Map<string, Running>()

  protected abstract binary(input?: AgentRunInput): string
  protected abstract command(input: AgentRunInput): Promise<{ argv: readonly string[]; env: Readonly<Record<string, string>>; stdin?: string; finalResponsePath?: string }>
  protected abstract normalize(native: unknown, sequence: number, at: string): NormalizedAgentEvent | null
  protected abstract credentialEnvironment(input: AgentRunInput): Readonly<Record<string, string>>
  protected abstract acceptedCredentialProviders(): readonly string[]

  async preflight(config: AgentRunInput['variant']): Promise<PreflightResult> {
    const accepted = new Set(this.acceptedCredentialProviders())
    const compatible = config.credentialRefs.filter((reference) => accepted.has(reference.provider))
    const errors = compatible.length > 0 ? [] : [{ code: 'CREDENTIAL_REFERENCE_MISSING', message: this.descriptor.label + ' requires a credential reference for one of: ' + [...accepted].join(', ') }]
    return { ok: errors.length === 0, errors, warnings: [{ code: 'SANDBOX_BINARY_PREFLIGHT_DEFERRED', message: 'binary availability and version are verified inside each fresh trial sandbox' }], resolvedVersion: this.descriptor.version, capabilities: this.descriptor.capabilities }
  }

  async start(input: AgentRunInput, signal: AbortSignal): Promise<AgentRunHandle> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason ?? new Error('Agent cancelled'))
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    const versionResult = await input.sandbox.execute({ argv: [this.binary(input), '--version'], cwd: input.sandbox.workspacePath, env: this.baseEnvironment(input), timeoutMs: 10_000 }, controller.signal)
    if (versionResult.exitCode !== 0) throw new Error(this.descriptor.label + ' binary preflight failed: ' + versionResult.stderr.slice(0, 500))
    const command = await this.command(input)
    const handle: AgentRunHandle = { handleId: this.descriptor.id + '-' + randomUUID(), startedAt: new Date().toISOString(), nativeProcessIds: [] }
    const eventQueue = new AsyncQueue<NormalizedAgentEvent>()
    const running: Running = { handle, input, controller, eventQueue, events: [], native: [], version: versionResult.stdout.trim() || this.descriptor.version, configHash: input.variant.configHash, finalResponsePath: command.finalResponsePath, done: Promise.resolve(undefined as never) }
    const startedNative = { type: 'adapter.started', backendId: this.descriptor.id, handleId: handle.handleId }
    const started = normalizedEvent(startedNative, 0, handle.startedAt, 'status')
    running.native.push(startedNative); running.events.push(started); eventQueue.push(started)
    const emitNative = (native: unknown): void => {
      running.native.push(native)
      const normalized = this.normalize(native, running.events.length, new Date().toISOString())
      if (normalized) { running.events.push(normalized); eventQueue.push(normalized) }
    }
    const decoder = new JsonLineDecoder(emitNative)
    running.done = input.sandbox.execute({ argv: command.argv, cwd: input.sandbox.workspacePath, env: { ...this.baseEnvironment(input), ...command.env }, stdin: command.stdin, timeoutMs: Math.max(1, Date.parse(input.absoluteDeadline) - Date.now()), onStdout: (chunk) => decoder.write(chunk) }, controller.signal)
      .then((result) => {
        decoder.end()
        if (result.timedOut) throw new AgentBackendTimeoutError(this.descriptor.label + ' exceeded its absolute deadline')
        if (result.exitCode !== 0) {
          const diagnostic = (result.stderr + '\n' + result.stdout).trim().slice(0, 2_000)
          const provider = transientProviderError(diagnostic, this.descriptor.label + ' provider request')
          if (provider) throw provider
          throw new Error(this.descriptor.label + ' exited with ' + String(result.exitCode) + ': ' + diagnostic)
        }
        eventQueue.close(); return result
      })
      .catch((error: unknown) => { eventQueue.close(error); throw error })
    void running.done.catch(() => undefined)
    this.runs.set(handle.handleId, running)
    return handle
  }

  async *events(handle: AgentRunHandle): AsyncIterable<NormalizedAgentEvent> {
    const run = this.required(handle)
    for await (const event of run.eventQueue) yield event
  }

  async cancel(handle: AgentRunHandle): Promise<void> { this.required(handle).controller.abort(new Error('Agent adapter cancelled')) }

  async collect(handle: AgentRunHandle): Promise<AgentRunArtifacts> {
    const run = this.required(handle); const result = await run.done
    const diff = await captureFinalDiff(run.input.sandbox, run.input.sandbox.workspacePath)
    let finalResponse: string | undefined
    if (run.finalResponsePath) {
      const response = await run.input.sandbox.execute({ argv: ['sh', '-ceu', 'test -f "$1" && cat "$1"', 'response', run.finalResponsePath], cwd: run.input.sandbox.workspacePath, timeoutMs: 10_000 }).catch(() => undefined)
      if (response?.exitCode === 0) finalResponse = response.stdout
    }
    const usage = usageFromNative(run.native)
    this.runs.delete(handle.handleId)
    return { completedAt: result.completedAt, ...(finalResponse ? { finalResponse } : {}), finalDiff: diff?.exitCode === 0 ? diff.stdout : '', nativeEvents: run.native, normalizedEvents: run.events, stdout: result.stdout, stderr: result.stderr, usage, version: run.version, configHash: run.configHash, extraArtifactPaths: [] }
  }

  protected async configHash(value: unknown): Promise<string> { return await sha256Hex(canonicalJson(value)) }
  private baseEnvironment(input: AgentRunInput): Readonly<Record<string, string>> { return { HOME: '/tmp/agent-home', TMPDIR: '/tmp', CI: '1', NO_COLOR: '1', ...this.credentialEnvironment(input) } }
  private required(handle: AgentRunHandle): Running { const run = this.runs.get(handle.handleId); if (!run) throw new Error('unknown Agent run handle: ' + handle.handleId); return run }
}

async function captureFinalDiff(sandbox: AgentRunInput['sandbox'], cwd: string): Promise<SandboxExecResult | undefined> {
  const script = `git_config=$(mktemp /tmp/agent-eval-diff.XXXXXX)
trap 'rm -f "$git_config"' EXIT
printf '[safe]\n\tdirectory = %s\n' "$PWD" > "$git_config"
GIT_CONFIG_GLOBAL="$git_config" git diff --binary --no-ext-diff
while IFS= read -r -d "" file; do
  git diff --binary --no-index -- /dev/null "$file" || test "$?" -eq 1
done < <(GIT_CONFIG_GLOBAL="$git_config" git ls-files --others --exclude-standard -z)`
  return await sandbox.execute({
    argv: ['bash', '-ceu', script],
    cwd, timeoutMs: 30_000,
  }).catch(() => undefined)
}

function usageFromNative(nativeEvents: readonly unknown[]): AgentRunArtifacts['usage'] {
  let inputTokens = 0, outputTokens = 0, found = false
  for (const event of nativeEvents) {
    if (!event || typeof event !== 'object') continue
    const value = event as Record<string, unknown>; const usage = value.usage && typeof value.usage === 'object' ? value.usage as Record<string, unknown> : value
    const input = number(usage.input_tokens ?? usage.inputTokens); const output = number(usage.output_tokens ?? usage.outputTokens)
    if (input !== undefined || output !== undefined) { found = true; inputTokens += input ?? 0; outputTokens += output ?? 0 }
  }
  return found ? { availability: 'available', inputTokens, outputTokens } : { availability: 'unavailable', reason: 'backend did not expose token usage in captured native events' }
}
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined }

export function normalizedEvent(native: unknown, sequence: number, at: string, kind: NormalizedAgentEvent['kind']): NormalizedAgentEvent {
  return { schemaVersion: 1, sequence, at, kind, nativeEventRef: 'native-events.jsonl#' + String(sequence), data: native && typeof native === 'object' ? native as Record<string, unknown> : { value: native } }
}

export function mapCredentialEnvironment(input: AgentRunInput, bindings: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {}
  for (const reference of input.variant.credentialRefs) {
    const name = bindings[reference.provider]
    if (!name) continue
    const value = input.credentialValues[reference.referenceId]
    if (!value) throw new Error('resolved credential value is unavailable for reference: ' + reference.referenceId)
    if (environment[name] !== undefined) throw new Error('multiple credential references map to ' + name)
    environment[name] = value
  }
  if (Object.keys(environment).length === 0) throw new Error('no compatible credential reference was resolved for ' + input.variant.backendId)
  return environment
}

class JsonLineDecoder {
  private buffer = ''
  constructor(private readonly emit: (native: unknown) => void) {}
  write(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      this.decode(this.buffer.slice(0, newline)); this.buffer = this.buffer.slice(newline + 1)
    }
  }
  end(): void { if (this.buffer.length > 0) this.decode(this.buffer); this.buffer = '' }
  private decode(line: string): void {
    if (!line) return
    try { this.emit(JSON.parse(line)) } catch { this.emit({ type: 'stdout', text: line }) }
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = []
  private ended = false
  private error: unknown
  push(value: T): void { const waiter = this.waiters.shift(); if (waiter) waiter.resolve({ value, done: false }); else if (!this.ended) this.values.push(value) }
  close(error?: unknown): void {
    if (this.ended) return
    this.ended = true; this.error = error
    for (const waiter of this.waiters.splice(0)) error === undefined ? waiter.resolve({ value: undefined, done: true }) : waiter.reject(error)
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: async () => {
      const value = this.values.shift(); if (value !== undefined) return { value, done: false }
      if (this.ended) { if (this.error !== undefined) throw this.error; return { value: undefined, done: true } }
      return await new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }))
    } }
  }
}
