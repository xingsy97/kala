import { randomUUID } from 'node:crypto'

import { AgentBackendDescriptorSchema, NormalizedAgentEventSchema, type AgentVariantSpec, type NormalizedAgentEvent, type PreflightResult } from '@agent-kernel/eval-protocol'
import type { AgentBackendPlugin, AgentRunArtifacts, AgentRunHandle, AgentRunInput, EvaluationAgentBackend, SandboxExecResult } from '@agent-kernel/eval-sdk'

type CommandConfig = { argv: string[]; stdin?: string; env: Record<string, string> }
type RunningCommand = {
  handle: AgentRunHandle
  input: AgentRunInput
  controller: AbortController
  done: Promise<SandboxExecResult>
  nativeEvents: Array<Record<string, unknown>>
  normalizedEvents: NormalizedAgentEvent[]
}

export class CustomCommandAgentBackend implements EvaluationAgentBackend {
  readonly descriptor = AgentBackendDescriptorSchema.parse({
    schemaVersion: 1,
    id: 'custom-command',
    label: 'Custom Command',
    version: '1.0.0',
    configSchemaVersion: 1,
    ranked: false,
    evidenceLevel: 'native',
    capabilities: {
      nonInteractive: true, workspaceInjection: true, isolatedConfig: true, cancellation: true,
      absoluteDeadline: true, nativeEvents: true, normalizedEvents: true, toolEvents: false,
      finalDiff: true, usage: 'unavailable_explicit',
    },
  })
  private readonly runs = new Map<string, RunningCommand>()

  async preflight(variant: AgentVariantSpec): Promise<PreflightResult> {
    const errors: Array<{ code: string; message: string }> = []
    if (variant.credentialRefs.length > 0) errors.push({ code: 'CREDENTIALS_UNSUPPORTED', message: 'custom-command does not accept credential references' })
    try { commandConfig(variant) } catch (error) { errors.push({ code: 'INVALID_COMMAND_CONFIG', message: safeMessage(error) }) }
    return { ok: errors.length === 0, errors, warnings: [], resolvedVersion: this.descriptor.version, capabilities: this.descriptor.capabilities }
  }

  async start(input: AgentRunInput, signal: AbortSignal): Promise<AgentRunHandle> {
    const config = commandConfig(input.variant)
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason ?? new Error('custom command cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const handle: AgentRunHandle = { handleId: 'custom-command-' + randomUUID(), startedAt: new Date().toISOString(), nativeProcessIds: [] }
    const started = { type: 'command.started', argv: config.argv, handleId: handle.handleId }
    const running: RunningCommand = {
      handle, input, controller, nativeEvents: [started], normalizedEvents: [normalized(started, 0, handle.startedAt, 'command')],
      done: Promise.resolve(undefined as never),
    }
    running.done = input.sandbox.execute({
      argv: config.argv, cwd: input.sandbox.workspacePath, env: config.env, stdin: config.stdin,
      timeoutMs: Math.max(1, Date.parse(input.absoluteDeadline) - Date.now()),
    }, controller.signal).then((result) => {
      const completed = { type: 'command.completed', exitCode: result.exitCode, timedOut: result.timedOut, handleId: handle.handleId }
      running.nativeEvents.push(completed)
      running.normalizedEvents.push(normalized(completed, 1, result.completedAt, result.exitCode === 0 && !result.timedOut ? 'status' : 'error'))
      if (result.timedOut) throw new Error('custom command exceeded its absolute deadline')
      if (result.exitCode !== 0) throw new Error('custom command exited with ' + String(result.exitCode) + ': ' + (result.stderr || result.stdout).trim().slice(0, 1_000))
      return result
    }).finally(() => signal.removeEventListener('abort', abort))
    void running.done.catch(() => undefined)
    this.runs.set(handle.handleId, running)
    return handle
  }

  async *events(handle: AgentRunHandle): AsyncIterable<NormalizedAgentEvent> {
    const running = this.required(handle)
    yield running.normalizedEvents[0]!
    await running.done
    yield running.normalizedEvents[1]!
  }

  async cancel(handle: AgentRunHandle): Promise<void> {
    this.required(handle).controller.abort(new Error('custom command cancelled'))
  }

  async collect(handle: AgentRunHandle): Promise<AgentRunArtifacts> {
    const running = this.required(handle)
    const result = await running.done
    const diff = await running.input.sandbox.execute({
      argv: ['bash', '-ceu', `git_config=$(mktemp /tmp/agent-eval-diff.XXXXXX)
trap 'rm -f "$git_config"' EXIT
printf '[safe]\n\tdirectory = %s\n' "$PWD" > "$git_config"
GIT_CONFIG_GLOBAL="$git_config" git diff --binary --no-ext-diff
while IFS= read -r -d "" file; do
  GIT_CONFIG_GLOBAL="$git_config" git diff --binary --no-index -- /dev/null "$file" || test "$?" -eq 1
done < <(GIT_CONFIG_GLOBAL="$git_config" git ls-files --others --exclude-standard -z)`],
      cwd: running.input.sandbox.workspacePath, timeoutMs: 30_000,
    }).catch(() => undefined)
    this.runs.delete(handle.handleId)
    return {
      completedAt: result.completedAt, finalResponse: result.stdout, finalDiff: diff?.exitCode === 0 ? diff.stdout : '',
      nativeEvents: running.nativeEvents, normalizedEvents: running.normalizedEvents, stdout: result.stdout, stderr: result.stderr,
      usage: { availability: 'unavailable', reason: 'custom-command does not invoke a metered model provider' },
      version: this.descriptor.version, configHash: running.input.variant.configHash, extraArtifactPaths: [],
    }
  }

  private required(handle: AgentRunHandle): RunningCommand {
    const running = this.runs.get(handle.handleId)
    if (!running) throw new Error('unknown custom command handle: ' + handle.handleId)
    return running
  }
}

function commandConfig(variant: AgentVariantSpec): CommandConfig {
  const argv = variant.config.argv
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('config.argv must be a non-empty string array')
  }
  const stdin = variant.config.stdin
  if (stdin !== undefined && typeof stdin !== 'string') throw new Error('config.stdin must be a string')
  const rawEnvironment = variant.config.env ?? {}
  if (!rawEnvironment || typeof rawEnvironment !== 'object' || Array.isArray(rawEnvironment)) throw new Error('config.env must be a string record')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(rawEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string') throw new Error('config.env must be a string record with environment variable keys')
    env[key] = value
  }
  return { argv: [...argv], ...(stdin === undefined ? {} : { stdin }), env }
}

function normalized(native: Record<string, unknown>, sequence: number, at: string, kind: 'command' | 'status' | 'error'): NormalizedAgentEvent {
  return NormalizedAgentEventSchema.parse({ schemaVersion: 1, sequence, at, kind, data: native })
}
function safeMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }

export function createCustomCommandAgentBackend(): CustomCommandAgentBackend { return new CustomCommandAgentBackend() }
export const evaluationPlugins: readonly AgentBackendPlugin[] = [{ kind: 'agent-backend', descriptor: createCustomCommandAgentBackend().descriptor, create: createCustomCommandAgentBackend }]
