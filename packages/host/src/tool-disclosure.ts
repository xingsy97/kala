import type { ToolSchema } from '@agent-kernel/kernel'
import { createHash } from 'node:crypto'

export type ToolDisclosureMode = 'legacy_full' | 'progressive'
export type ToolDisclosureSnapshot = { catalogRevision: string; active: readonly string[] }

const DISCOVERY = new Set(['tool_search', 'tool_describe'])
const DEFAULT_CORE = new Set(['read_file', 'read_files', 'ls', 'glob', 'grep', 'multi_grep', 'shell', 'todowrite', 'todo_graph', 'agent'])

export function toolCatalogRevision(tools: readonly ToolSchema[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(tools.map(stableTool))).digest('hex')}`
}

export function visibleTools(tools: readonly ToolSchema[], mode: ToolDisclosureMode, active: ReadonlySet<string>): readonly ToolSchema[] {
  if (mode === 'legacy_full') return tools
  return tools.filter((tool) => DISCOVERY.has(tool.name) || DEFAULT_CORE.has(tool.name) || active.has(tool.name))
}

export function searchToolCatalog(tools: readonly ToolSchema[], query: string, limit = 8): readonly ToolSchema[] {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return []
  return tools
    .filter((tool) => !DISCOVERY.has(tool.name))
    .map((tool, index) => ({ tool, index, score: scoreTool(tool, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map((entry) => entry.tool)
}

export function activateTools(tools: readonly ToolSchema[], current: ReadonlySet<string>, names: readonly string[]): Set<string> {
  const available = new Set(tools.map((tool) => tool.name))
  const next = new Set(current)
  for (const name of names) {
    if (!available.has(name)) throw new Error(`tool is not in the locked catalog: ${name}`)
    next.add(name)
  }
  return next
}

function scoreTool(tool: ToolSchema, terms: readonly string[]): number {
  const name = tool.name.toLocaleLowerCase()
  const text = `${tool.name} ${tool.description} ${tool.toolsetId ?? ''} ${tool.risk ?? ''} ${tool.executionKind ?? ''}`.toLocaleLowerCase()
  let score = 0
  for (const term of terms) {
    if (name === term) score += 100
    else if (name.includes(term)) score += 25
    if (text.includes(term)) score += 5
  }
  return score
}

function stableTool(tool: ToolSchema): unknown {
  return {
    name: tool.name, version: tool.version ?? null, schemaHash: tool.schemaHash ?? null,
    toolsetId: tool.toolsetId ?? null, toolsetVersion: tool.toolsetVersion ?? null,
    executionKind: tool.executionKind ?? null, executionHandler: tool.executionHandler ?? null,
  }
}
