/**
 * Router decision and tool catalog artifacts. These are derived views of the
 * router state at call time — the kernel never sees them.
 */

import type { ToolSchema } from '@agent-kernel/kernel'

import { inferProvider, stableId, compactRecord } from './trace-spans.js'

export type RouterDecisionArtifact = {
  selectedProvider?: string
  selectedModel?: string
  requestedModelRef?: string
  routedModelId?: string
  reasonCodes: readonly string[]
  fallbacks: readonly string[]
  budget?: {
    maxInputTokens?: number
    maxOutputTokens?: number
  }
  toolPolicy?: {
    toolCount: number
    requiresApprovalCount: number
    skillBackedCount: number
    subAgentToolAvailable: boolean
    memoryToolAvailable: boolean
  }
  /**
   * Capabilities the router determined were needed for this call. Filled in
   * from the effect (tool schemas, image inputs, requested reasoning budget)
   * and cross-checked against provider/executor capability snapshots when
   * available. Purely observational — the reducer never sees this.
   */
  capabilityRequirements?: {
    toolCalling: boolean
    imageInput: boolean
    reasoningBudget: boolean
    minContextTokens?: number
    requiredTools?: readonly string[]
  }
}

export type ToolCatalogArtifact = {
  toolCount: number
  tools: Array<{
    name: string
    requiresApproval: boolean
    kind: 'executor' | 'host' | 'skill_loader' | 'sub_agent' | 'unknown'
    skillBacked: boolean
    descriptionChars: number
    schemaHash: string
  }>
}

/**
 * Snapshot of currently-attached executors as observed by the host. Written
 * on demand (e.g. from an ops CLI action) so operators can diff executor
 * capabilities across time or reject stale registrations against a known
 * baseline.
 */
export type ExecutorCapabilitySnapshotArtifact = {
  schemaVersion: 1
  generatedAt: string
  executorCount: number
  executors: readonly {
    executorId: string
    workspaceId: string
    workspaceName: string
    runtime: string
    runtimeVersion: string
    os?: string
    hostname?: string
    attachedAt: string
    clientVersion?: string
    tools: readonly string[]
    toolCount: number
    sandboxRoots?: readonly string[]
    defaultCwd?: string
    /** @deprecated Use `defaultCwd`. */
    workingDir?: string
  }[]
  summary: {
    runtimes: Record<string, number>
    osCounts: Record<string, number>
    toolCoverage: Record<string, number>
  }
}

export function createRouterDecisionArtifact(input: {
  requestedModel?: string
  selectedModel?: string
  requestedModelRef?: string
  routedModelId?: string
  adapterName?: string
  reasonCodes?: readonly string[]
  fallbacks?: readonly string[]
  maxInputTokens?: number
  maxOutputTokens?: number
  tools?: readonly ToolSchema[]
  hasImageInput?: boolean
  reasoningBudgetRequested?: boolean
  requiredTools?: readonly string[]
  minContextTokens?: number
}): RouterDecisionArtifact {
  const selectedProvider = providerFromAdapter(input.adapterName) ?? inferProvider(input.selectedModel ?? input.requestedModel)
  const toolPolicy = input.tools ? createToolPolicy(input.tools) : undefined
  const capabilityRequirements = createCapabilityRequirements(input)
  return {
    ...(selectedProvider ? { selectedProvider } : {}),
    ...(input.selectedModel ?? input.requestedModel ? { selectedModel: input.selectedModel ?? input.requestedModel } : {}),
    ...(input.requestedModelRef ?? input.requestedModel ? { requestedModelRef: input.requestedModelRef ?? input.requestedModel } : {}),
    ...(input.routedModelId ?? input.selectedModel ? { routedModelId: input.routedModelId ?? input.selectedModel } : {}),
    reasonCodes: input.reasonCodes ?? [
      input.requestedModel ? 'session_model_selected' : 'adapter_default_model',
      ...(toolPolicy ? toolReasonCodes(toolPolicy) : []),
      ...(capabilityRequirements ? capabilityReasonCodes(capabilityRequirements) : []),
    ],
    fallbacks: input.fallbacks ?? [],
    budget: compactRecord({
      maxInputTokens: input.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens,
    }),
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(capabilityRequirements ? { capabilityRequirements } : {}),
  }
}

function createCapabilityRequirements(input: {
  tools?: readonly ToolSchema[]
  hasImageInput?: boolean
  reasoningBudgetRequested?: boolean
  requiredTools?: readonly string[]
  minContextTokens?: number
}): RouterDecisionArtifact['capabilityRequirements'] | undefined {
  const toolCalling = (input.tools?.length ?? 0) > 0
  const imageInput = input.hasImageInput === true
  const reasoningBudget = input.reasoningBudgetRequested === true
  const requiredTools = input.requiredTools?.filter((n) => n.length > 0)
  const minContextTokens = input.minContextTokens
  if (!toolCalling && !imageInput && !reasoningBudget && !(requiredTools && requiredTools.length > 0) && minContextTokens === undefined) {
    return undefined
  }
  return {
    toolCalling,
    imageInput,
    reasoningBudget,
    ...(minContextTokens !== undefined ? { minContextTokens } : {}),
    ...(requiredTools && requiredTools.length > 0 ? { requiredTools } : {}),
  }
}

function capabilityReasonCodes(reqs: NonNullable<RouterDecisionArtifact['capabilityRequirements']>): readonly string[] {
  return [
    ...(reqs.imageInput ? ['image_input_required'] : []),
    ...(reqs.reasoningBudget ? ['reasoning_budget_required'] : []),
    ...(reqs.requiredTools && reqs.requiredTools.length > 0 ? ['specific_tools_required'] : []),
    ...(reqs.minContextTokens !== undefined ? ['context_size_required'] : []),
  ]
}

function createToolPolicy(tools: readonly ToolSchema[]): NonNullable<RouterDecisionArtifact['toolPolicy']> {
  return {
    toolCount: tools.length,
    requiresApprovalCount: tools.filter((tool) => tool.requiresApproval).length,
    skillBackedCount: tools.filter((tool) => tool.name === 'skill').length,
    subAgentToolAvailable: tools.some((tool) => tool.name === 'agent'),
    memoryToolAvailable: tools.some((tool) => tool.name === 'memory'),
  }
}

function toolReasonCodes(policy: NonNullable<RouterDecisionArtifact['toolPolicy']>): readonly string[] {
  return [
    policy.toolCount > 0 ? 'tool_calling_enabled' : 'tool_calling_disabled',
    ...(policy.requiresApprovalCount > 0 ? ['approval_required_tools_visible'] : []),
    ...(policy.skillBackedCount > 0 ? ['skill_backed_tools_visible'] : []),
    ...(policy.subAgentToolAvailable ? ['sub_agent_tool_visible'] : []),
    ...(policy.memoryToolAvailable ? ['memory_tool_visible'] : []),
  ]
}

export function createToolCatalogArtifact(tools: readonly ToolSchema[]): ToolCatalogArtifact {
  return {
    toolCount: tools.length,
    tools: tools.map((tool) => ({
      name: tool.name,
      requiresApproval: tool.requiresApproval,
      kind: toolKind(tool.name),
      skillBacked: tool.name === 'skill',
      descriptionChars: tool.description.length,
      schemaHash: stableId(JSON.stringify(tool.inputSchema), 16),
    })),
  }
}

function providerFromAdapter(adapterName: string | undefined): string | undefined {
  if (!adapterName) return undefined
  const lower = adapterName.toLowerCase()
  if (lower.includes('anthropic')) return 'anthropic'
  if (lower.includes('openai')) return 'openai'
  if (lower.includes('router(')) return 'router'
  return undefined
}

function toolKind(name: string): ToolCatalogArtifact['tools'][number]['kind'] {
  if (name === 'skill') return 'skill_loader'
  if (name === 'agent') return 'sub_agent'
  if (name === 'memory' || name === 'todo_graph') return 'host'
  if (
    name === 'bash' ||
    name === 'bash_output' ||
    name === 'kill_shell' ||
    name === 'read' ||
    name === 'write' ||
    name === 'edit' ||
    name === 'ls' ||
    name === 'glob' ||
    name === 'grep' ||
    name === 'todowrite' ||
    name === 'websearch'
  ) return 'executor'
  return 'unknown'
}
