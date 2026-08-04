import {
  SandboxDescriptorSchema,
  defineSandboxProviderPlugin,
  type EvaluationSandboxProvider,
  type PreflightResult,
  type SandboxCollectedArtifacts,
  type SandboxCreateInput,
  type SandboxExecutionTarget,
  type SandboxPolicy,
} from '@agent-kernel/eval-sdk'

const descriptor = SandboxDescriptorSchema.parse({
  schemaVersion: 1,
  providerId: 'example:sample-sandbox',
  kind: 'docker',
  version: '1.0.0',
  protocolVersions: [1],
  capabilities: ['preflight', 'create', 'execute', 'snapshot', 'collect', 'destroy', 'verify-destroyed', 'reap-orphans'],
})

/** Contract-only starter: replace every method with a provider-specific, isolated implementation. */
class SampleSandboxProvider implements EvaluationSandboxProvider {
  readonly descriptor = descriptor

  async preflight(policy: SandboxPolicy): Promise<PreflightResult> {
    const errors = policy.provider === descriptor.kind ? [] : [{ code: 'provider-mismatch', message: 'policy provider must match ' + descriptor.kind }]
    return { ok: errors.length === 0, errors, warnings: [], resolvedVersion: descriptor.version }
  }

  async create(_input: SandboxCreateInput): Promise<SandboxExecutionTarget> { throw new Error('sample sandbox provider is a contract starter and does not execute workloads') }
  async collect(_target: SandboxExecutionTarget): Promise<SandboxCollectedArtifacts> { throw new Error('sample sandbox provider does not collect workloads') }
  async destroy(_target: SandboxExecutionTarget): Promise<void> { throw new Error('sample sandbox provider has no created workload') }
  async verifyDestroyed(_target: SandboxExecutionTarget): Promise<boolean> { return true }
  async reapOrphans(_workerId: string): Promise<readonly string[]> { return [] }
}

export const evaluationPlugins = [defineSandboxProviderPlugin({
  kind: 'sandbox-provider', descriptor, create: () => new SampleSandboxProvider(),
})]
