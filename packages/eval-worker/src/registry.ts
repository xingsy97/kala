import { negotiateProtocolVersion, type AgentVariantSpec, type ResolvedTask } from '@agent-kernel/eval-protocol'
import type { EvaluationAgentBackend, EvaluationBenchmarkAdapter, EvaluationSandboxProvider } from '@agent-kernel/eval-sdk'

export class WorkerRuntimeRegistry {
  private readonly sandboxes = new Map<string, EvaluationSandboxProvider>()
  private readonly agents = new Map<string, EvaluationAgentBackend>()
  private readonly benchmarks = new Map<string, EvaluationBenchmarkAdapter>()

  registerSandbox(provider: EvaluationSandboxProvider): void {
    negotiateProtocolVersion([1], provider.descriptor.protocolVersions)
    uniqueSet(this.sandboxes, provider.descriptor.kind, provider, 'sandbox provider')
  }

  registerAgent(backend: EvaluationAgentBackend): void {
    negotiateProtocolVersion([1], backend.descriptor.protocolVersions)
    uniqueSet(this.agents, backend.descriptor.id, backend, 'Agent backend')
  }

  registerBenchmark(adapter: EvaluationBenchmarkAdapter): void {
    negotiateProtocolVersion([1], adapter.descriptor.protocolVersions)
    uniqueSet(this.benchmarks, adapter.descriptor.id, adapter, 'benchmark adapter')
  }

  sandbox(kind: string): EvaluationSandboxProvider {
    return required(this.sandboxes, kind, 'sandbox provider')
  }

  agent(variant: AgentVariantSpec): EvaluationAgentBackend {
    return required(this.agents, variant.backendId, 'Agent backend')
  }

  benchmark(task: ResolvedTask): EvaluationBenchmarkAdapter {
    return required(this.benchmarks, task.taskPackId, 'benchmark adapter')
  }

  agentBackends(): readonly EvaluationAgentBackend[] { return [...this.agents.values()] }

  capabilities(): { sandboxes: string[]; agents: string[]; benchmarks: string[] } {
    return { sandboxes: [...this.sandboxes.keys()], agents: [...this.agents.keys()], benchmarks: [...this.benchmarks.keys()] }
  }

  sandboxProviders(): readonly EvaluationSandboxProvider[] { return [...this.sandboxes.values()] }
}

function uniqueSet<K, V>(map: Map<K, V>, key: K, value: V, kind: string): void {
  if (map.has(key)) throw new Error('duplicate ' + kind + ': ' + String(key))
  map.set(key, value)
}

function required<K, V>(map: ReadonlyMap<K, V>, key: K, kind: string): V {
  const value = map.get(key)
  if (!value) throw new Error('unknown ' + kind + ': ' + String(key))
  return value
}
