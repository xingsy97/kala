import type { McpServerConfig } from '@agent-kernel/shared'

import type { ToolSchema } from '@agent-kernel/kernel'

export function initMcp(config: {
  mcpServers?: readonly McpServerConfig[]
}): { tools: readonly ToolSchema[] } {
  const count = config.mcpServers?.length ?? 0
  if (count > 0) {
    console.log(`mcp: not implemented, ignoring ${count} servers`)
  }
  return { tools: [] }
}
