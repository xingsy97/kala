import { negotiateProtocolVersion, type AgentBackendDescriptor, type BenchmarkDescriptor, type DefectDetector, type DefectDetectorDescriptor, type SandboxDescriptor } from '@agent-kernel/eval-protocol'

import type { EvaluationAgentBackend, EvaluationBenchmarkAdapter, EvaluationSandboxProvider } from './runtime.js'

export type AgentBackendPlugin = { kind: 'agent-backend'; descriptor: AgentBackendDescriptor; create(): EvaluationAgentBackend }
export type BenchmarkAdapterPlugin = { kind: 'benchmark-adapter'; descriptor: BenchmarkDescriptor; create(): EvaluationBenchmarkAdapter }
export type SandboxProviderPlugin = { kind: 'sandbox-provider'; descriptor: SandboxDescriptor; create(): EvaluationSandboxProvider }
export type DefectDetectorPlugin<AnalysisInput = unknown, ReproductionHarness = unknown, MinimalReproduction = unknown> = {
  kind: 'defect-detector'
  descriptor: DefectDetectorDescriptor
  create(): DefectDetector<AnalysisInput, ReproductionHarness, MinimalReproduction>
}
export type EvaluationPlugin = AgentBackendPlugin | BenchmarkAdapterPlugin | SandboxProviderPlugin | DefectDetectorPlugin<never, unknown, unknown>

export const RUNTIME_PLUGIN_CAPABILITIES = {
  'agent-backend': ['non-interactive', 'workspace-injection', 'isolated-config', 'cancellation', 'absolute-deadline', 'normalized-events', 'final-diff'],
  'benchmark-adapter': ['resolve-tasks', 'prepare-task', 'verify', 'explain', 'normalize-failure'],
  'sandbox-provider': ['preflight', 'create', 'execute', 'snapshot', 'collect', 'destroy', 'verify-destroyed', 'reap-orphans'],
  'defect-detector': ['analyze'],
} as const

export type PluginNegotiation = { protocolVersion: number; capabilities: readonly string[] }

export function defineAgentBackendPlugin(plugin: AgentBackendPlugin): AgentBackendPlugin { return plugin }
export function defineBenchmarkAdapterPlugin(plugin: BenchmarkAdapterPlugin): BenchmarkAdapterPlugin { return plugin }
export function defineSandboxProviderPlugin(plugin: SandboxProviderPlugin): SandboxProviderPlugin { return plugin }
export function defineDefectDetectorPlugin<AnalysisInput, ReproductionHarness = unknown, MinimalReproduction = unknown>(
  plugin: DefectDetectorPlugin<AnalysisInput, ReproductionHarness, MinimalReproduction>,
): DefectDetectorPlugin<AnalysisInput, ReproductionHarness, MinimalReproduction> { return plugin }

export class PluginRegistry {
  private readonly plugins = new Map<string, EvaluationPlugin>()

  register(plugin: EvaluationPlugin): void {
    negotiateEvaluationPlugin(plugin, { requireNamespacedId: false })
    const key = pluginKey(plugin)
    if (this.plugins.has(key)) throw new Error('duplicate evaluation plugin: ' + key)
    this.plugins.set(key, plugin)
  }

  list(kind?: EvaluationPlugin['kind']): readonly EvaluationPlugin[] {
    return [...this.plugins.values()].filter((plugin) => kind === undefined || plugin.kind === kind)
  }

  get(kind: EvaluationPlugin['kind'], id: string): EvaluationPlugin {
    const plugin = this.plugins.get(kind + ':' + id)
    if (!plugin) throw new Error('unknown evaluation plugin: ' + kind + ':' + id)
    return plugin
  }
}

export function assertPluginMatchesDescriptor(plugin: EvaluationPlugin): void {
  const instance = plugin.create()
  if (JSON.stringify(instance.descriptor) !== JSON.stringify(plugin.descriptor)) throw new Error(plugin.kind + ' descriptor mismatch')
  negotiateProtocolVersion(instance.descriptor.protocolVersions, plugin.descriptor.protocolVersions)
}

/** Validate an external plugin before create() and return the selected runtime contract. */
export function negotiateEvaluationPlugin(
  plugin: EvaluationPlugin,
  options: { protocolVersions?: readonly number[]; requireNamespacedId?: boolean; requiredCapabilities?: readonly string[] } = {},
): PluginNegotiation {
  const id = pluginId(plugin)
  if (options.requireNamespacedId !== false && !isNamespacedPluginId(id)) {
    throw new Error('external evaluation plugin ID must be namespaced (for example acme:' + id + '): ' + id)
  }
  if (!plugin.descriptor.version.trim()) throw new Error('evaluation plugin version is required: ' + id)
  const protocolVersion = negotiateProtocolVersion(options.protocolVersions ?? [1], plugin.descriptor.protocolVersions)
  const capabilities = descriptorCapabilities(plugin)
  const required = options.requiredCapabilities ?? RUNTIME_PLUGIN_CAPABILITIES[plugin.kind]
  const missing = required.filter((capability) => !capabilities.includes(capability))
  if (missing.length) throw new Error('evaluation plugin lacks required capabilities: ' + id + ': ' + missing.join(', '))
  return { protocolVersion, capabilities }
}

export function isNamespacedPluginId(id: string): boolean {
  const separator = id.indexOf(':')
  return separator > 0 && separator < id.length - 1
}

function pluginKey(plugin: EvaluationPlugin): string {
  if (plugin.kind === 'sandbox-provider') return plugin.kind + ':' + plugin.descriptor.providerId
  return plugin.kind + ':' + plugin.descriptor.id
}

function pluginId(plugin: EvaluationPlugin): string {
  return plugin.kind === 'sandbox-provider' ? plugin.descriptor.providerId : plugin.descriptor.id
}

function descriptorCapabilities(plugin: EvaluationPlugin): string[] {
  if (plugin.kind !== 'agent-backend') return [...plugin.descriptor.capabilities]
  const capabilities = plugin.descriptor.capabilities
  return [
    capabilities.nonInteractive && 'non-interactive', capabilities.workspaceInjection && 'workspace-injection',
    capabilities.isolatedConfig && 'isolated-config', capabilities.cancellation && 'cancellation',
    capabilities.absoluteDeadline && 'absolute-deadline', capabilities.nativeEvents && 'native-events',
    capabilities.normalizedEvents && 'normalized-events', capabilities.toolEvents && 'tool-events',
    capabilities.finalDiff && 'final-diff', capabilities.usage === 'available' ? 'usage' : 'usage-unavailable-explicit',
  ].filter((value): value is string => Boolean(value))
}
