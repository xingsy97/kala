import { createHash } from 'node:crypto'

import { createConfig, type AgentModuleMetadata, type ToolSchema } from '@agent-kernel/kernel'

import type { AgentModule, AgentModuleContext, ResolvedAgentModule, ToolDefinition } from './types.js'

export function resolveAgentModule(
  module: AgentModule,
  ctx: AgentModuleContext,
): ResolvedAgentModule {
  const systemPrompt = module.systemPrompt.render(ctx)
  const toolDefinitions = module.toolsets.flatMap((toolset) =>
    toolset.provideTools(ctx).map((tool) => ({
      ...tool,
      toolsetId: toolset.id,
      toolsetVersion: toolset.version,
      toolsetLabel: toolset.label,
    })),
  )
  assertUniqueToolNames(toolDefinitions)
  const tools = toolDefinitions.map(renderToolSchema)
  const metadata: AgentModuleMetadata = {
    id: module.id,
    version: module.version,
    label: module.label,
    systemPromptHash: stableHash(systemPrompt),
    toolRegistryHash: stableHash(toolDefinitions),
    toolsets: module.toolsets.map((toolset) => ({
      id: toolset.id,
      version: toolset.version,
      label: toolset.label,
      toolCount: toolDefinitions.filter((tool) => tool.toolsetId === toolset.id).length,
    })),
  }
  const config = createConfig({
    tools,
    systemPrompt,
    agentModule: metadata,
    ...(ctx.contextLimit !== undefined ? { contextLimit: ctx.contextLimit } : {}),
  })
  return { module, systemPrompt, tools, toolDefinitions, metadata, config }
}

export function renderToolSchema(
  tool: ToolDefinition & { toolsetId: string; toolsetVersion: string },
): ToolSchema {
  const properties = typeof tool.inputSchema.properties === 'object' && tool.inputSchema.properties !== null ? tool.inputSchema.properties as Record<string, unknown> : {}
  const required = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((value): value is string => typeof value === 'string')
    : []
  const inputSchema = {
    ...tool.inputSchema,
    required: [...new Set([...required, '_intent'])],
    properties: {
      ...properties,
      _intent: {
        type: 'string',
        minLength: 1,
        maxLength: 160,
        description: 'Briefly explain in the user’s current language what this tool call is about to do and why it is needed. Use one natural-language sentence, do not merely restate the arguments, and do not include secrets, tokens, or sensitive file contents.',
      },
    },
  }
  return {
    name: tool.name,
    description: renderToolDescription(tool),
    inputSchema,
    requiresApproval: tool.requiresApproval,
    version: tool.version ?? '1.0.0',
    schemaHash: `sha256:${stableHash(inputSchema)}`,
    toolsetId: tool.toolsetId,
    toolsetVersion: tool.toolsetVersion,
    risk: tool.policy.risk,
    executionKind: tool.execution.kind,
    ...(tool.execution.handler !== undefined ? { executionHandler: tool.execution.handler } : {}),
  }
}

export function renderToolDescription(tool: ToolDefinition): string {
  const sections = [
    tool.prompt.purpose,
    listSection('Use when', tool.prompt.whenToUse),
    listSection('Constraints', tool.prompt.constraints),
    tool.prompt.failureHandling && tool.prompt.failureHandling.length > 0
      ? listSection('Failure handling', tool.prompt.failureHandling)
      : undefined,
  ].filter((part): part is string => Boolean(part))
  return sections.join('\n\n')
}

export function stableHash(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, objectKeySorter())
  return createHash('sha256').update(raw).digest('hex')
}

function listSection(title: string, items: readonly string[]): string {
  return `${title}:\n${items.map((item) => `- ${item}`).join('\n')}`
}

function assertUniqueToolNames(tools: readonly { name: string }[]): void {
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`duplicate tool name from agent module: ${tool.name}`)
    seen.add(tool.name)
  }
}

function objectKeySorter(): (this: unknown, key: string, value: unknown) => unknown {
  return (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
  }
}
