import {
  AgentBackendDescriptorSchema,
  defineAgentBackendPlugin,
  type AgentRunArtifacts,
  type AgentRunHandle,
  type AgentRunInput,
  type EvaluationAgentBackend,
  type NormalizedAgentEvent,
  type PreflightResult,
  type SandboxExecResult,
} from '@agent-kernel/eval-sdk'

const descriptor = AgentBackendDescriptorSchema.parse({
  schemaVersion: 1,
  protocolVersions: [1],
  id: 'example:sample-agent',
  label: 'Sample Agent',
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

type ActiveRun = { input: AgentRunInput; controller: AbortController; result: Promise<SandboxExecResult>; events: NormalizedAgentEvent[] }

class SampleAgentBackend implements EvaluationAgentBackend {
  readonly descriptor = descriptor
  private readonly active = new Map<string, ActiveRun>()

  async preflight(): Promise<PreflightResult> {
    return { ok: true, errors: [], warnings: [], resolvedVersion: descriptor.version, capabilities: descriptor.capabilities }
  }

  async start(input: AgentRunInput, signal: AbortSignal): Promise<AgentRunHandle> {
    const handle: AgentRunHandle = { handleId: 'sample-' + input.trialId, startedAt: new Date().toISOString(), nativeProcessIds: [] }
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const events: NormalizedAgentEvent[] = [{ schemaVersion: 1, sequence: 0, at: handle.startedAt, kind: 'status', data: { state: 'started', backendId: descriptor.id } }]
    const timeoutMs = Math.max(1, Date.parse(input.absoluteDeadline) - Date.now())
    const result = input.sandbox.execute({
      argv: ['example:sample-agent', '--non-interactive', '--workspace', input.sandbox.workspacePath],
      cwd: input.sandbox.workspacePath,
      stdin: input.task.prompt,
      timeoutMs,
    }, controller.signal)
    this.active.set(handle.handleId, { input, controller, result, events })
    return handle
  }

  async *events(handle: AgentRunHandle): AsyncIterable<NormalizedAgentEvent> {
    for (const event of this.required(handle).events) yield event
  }

  async cancel(handle: AgentRunHandle): Promise<void> { this.required(handle).controller.abort(new Error('sample Agent cancelled')) }

  async collect(handle: AgentRunHandle): Promise<AgentRunArtifacts> {
    const run = this.required(handle)
    const result = await run.result
    const diff = await run.input.sandbox.execute({ argv: ['git', 'diff', '--binary', '--no-ext-diff'], cwd: run.input.sandbox.workspacePath, timeoutMs: 30_000 })
    this.active.delete(handle.handleId)
    return {
      completedAt: result.completedAt,
      finalResponse: result.stdout.trim() || undefined,
      finalDiff: diff.exitCode === 0 ? diff.stdout : '',
      nativeEvents: run.events,
      normalizedEvents: run.events,
      stdout: result.stdout,
      stderr: result.stderr,
      usage: { availability: 'unavailable', reason: 'sample Agent does not expose usage' },
      version: descriptor.version,
      configHash: run.input.variant.configHash,
      extraArtifactPaths: [],
    }
  }

  private required(handle: AgentRunHandle): ActiveRun {
    const run = this.active.get(handle.handleId)
    if (!run) throw new Error('unknown sample Agent handle: ' + handle.handleId)
    return run
  }
}

export const evaluationPlugins = [defineAgentBackendPlugin({
  kind: 'agent-backend', descriptor, create: () => new SampleAgentBackend(),
})]
