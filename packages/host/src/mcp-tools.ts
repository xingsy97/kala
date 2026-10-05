import { createHash } from 'node:crypto'

import type { AgentConfig, ToolSchema } from '@agent-kernel/kernel'
import type { ExecutorAnnounce, McpToolDescriptor } from '@agent-kernel/shared'

const MAX_MCP_TOOLS = 512
const MAX_DESCRIPTION_BYTES = 4 * 1024
const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_SCHEMA_DEPTH = 20

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function assertSchemaDepth(value: unknown, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('MCP input schema is too deeply nested')
  if (!value || typeof value !== 'object') return
  for (const item of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    assertSchemaDepth(item, depth + 1)
  }
}

/** Semantic checks which the wire schema cannot perform without Host catalog context. */
export function validateMcpToolDescriptors(
  announcement: Pick<ExecutorAnnounce, 'tools' | 'mcpTools'>,
  reservedToolNames: ReadonlySet<string>,
): readonly McpToolDescriptor[] {
  const descriptors = announcement.mcpTools ?? []
  if (descriptors.length > MAX_MCP_TOOLS) throw new Error('too many MCP tool descriptors')
  const announcedNames = new Set(announcement.tools)
  const seen = new Set<string>()
  for (const descriptor of descriptors) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*__[A-Za-z0-9_-]+$/u.test(descriptor.name) || descriptor.name.length > 64) {
      throw new Error(`MCP tool name is not prefixed: ${descriptor.name}`)
    }
    if (seen.has(descriptor.name)) throw new Error(`duplicate MCP tool descriptor: ${descriptor.name}`)
    if (reservedToolNames.has(descriptor.name)) throw new Error(`MCP tool conflicts with Host tool: ${descriptor.name}`)
    if (!announcedNames.has(descriptor.name)) throw new Error(`MCP tool is missing from Executor tool catalog: ${descriptor.name}`)
    if (Buffer.byteLength(descriptor.description, 'utf8') > MAX_DESCRIPTION_BYTES) {
      throw new Error(`MCP tool description is too large: ${descriptor.name}`)
    }
    if (descriptor.inputSchema.type !== 'object') {
      throw new Error(`MCP input schema type must be object: ${descriptor.name}`)
    }
    assertSchemaDepth(descriptor.inputSchema)
    if (Buffer.byteLength(JSON.stringify(descriptor.inputSchema), 'utf8') > MAX_SCHEMA_BYTES) {
      throw new Error(`MCP input schema is too large: ${descriptor.name}`)
    }
    const actualHash = createHash('sha256').update(canonicalJson(descriptor.inputSchema)).digest('hex')
    if (actualHash !== descriptor.schemaHash) throw new Error(`MCP input schema hash mismatch: ${descriptor.name}`)
    seen.add(descriptor.name)
  }
  return descriptors
}

export function mcpToolsForWorkspace(
  executors: readonly ExecutorAnnounce[],
  workspaceId: string | undefined,
): readonly McpToolDescriptor[] | undefined {
  if (!workspaceId) return undefined
  return executors.find((executor) => executor.workspaceId === workspaceId)?.mcpTools
}

export function mergeMcpTools(
  base: AgentConfig,
  descriptors: readonly McpToolDescriptor[] | undefined,
): AgentConfig {
  if (!descriptors?.length) return base
  const reserved = new Set(base.tools.map((tool) => tool.name))
  const dynamic = descriptors.map((descriptor): ToolSchema => {
    if (reserved.has(descriptor.name)) throw new Error(`MCP tool conflicts with Host tool: ${descriptor.name}`)
    reserved.add(descriptor.name)
    return {
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      schemaHash: descriptor.schemaHash,
      version: descriptor.schemaHash,
      requiresApproval: true,
      executionKind: 'executor',
      executionHandler: descriptor.name,
    }
  })
  return { ...base, tools: [...base.tools, ...dynamic] }
}

/** MCP tools are always prefixed `<server>__`; a missing live descriptor is stale. */
export function isUnavailableMcpTool(
  announcement: ExecutorAnnounce,
  toolName: string,
  knownMcpToolNames: ReadonlySet<string>,
  sessionSchemaHash?: string,
): boolean {
  if (!sessionSchemaHash && !knownMcpToolNames.has(toolName)) return false
  const live = (announcement.mcpTools ?? []).find((tool) => tool.name === toolName)
  return !live || (sessionSchemaHash !== undefined && live.schemaHash !== sessionSchemaHash)
}
