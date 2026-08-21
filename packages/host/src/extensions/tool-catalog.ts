import { appendRuntimeMetadataEntry, readSessionLog } from '../store/log.js'
import type { SessionRecord } from '../store/session.js'
import { activateTools, searchToolCatalog, toolCatalogRevision } from '../tool-disclosure.js'

export async function activeToolsFor(record: SessionRecord): Promise<Set<string>> {
  const parsed = await readSessionLog(record.logPath)
  const revision = toolCatalogRevision(record.config.tools)
  const active = new Set<string>()
  for (const entry of parsed.runtimeMetadata) {
    if (entry.action !== 'tools_activated' || entry.payload.catalogRevision !== revision || !Array.isArray(entry.payload.names)) continue
    for (const name of entry.payload.names) if (typeof name === 'string') active.add(name)
  }
  return active
}

export async function runToolCatalogTool(record: SessionRecord, name: string, input: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
  try {
    const revision = toolCatalogRevision(record.config.tools)
    const current = await activeToolsFor(record)
    let selected
    if (name === 'tool_search') {
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      if (!query) return { ok: false, content: 'query is required' }
      selected = searchToolCatalog(record.config.tools, query, typeof input.limit === 'number' ? input.limit : 8)
    } else {
      const names = Array.isArray(input.names) ? input.names.filter((value): value is string => typeof value === 'string') : []
      if (names.length === 0) return { ok: false, content: 'names must contain at least one Tool name' }
      const byName = new Map(record.config.tools.map((tool) => [tool.name, tool]))
      selected = names.map((toolName) => byName.get(toolName)).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
      if (selected.length !== names.length) return { ok: false, content: 'one or more Tools are not in the locked Session catalog' }
    }
    const shouldActivate = input.activate !== false
    if (shouldActivate && selected.length > 0) {
      const next = activateTools(record.config.tools, current, selected.map((tool) => tool.name))
      const added = [...next].filter((toolName) => !current.has(toolName))
      if (added.length > 0) await appendRuntimeMetadataEntry(record.logPath, { sessionId: record.sessionId, action: 'tools_activated', payload: { catalogRevision: revision, names: added } })
    }
    return { ok: true, content: JSON.stringify({ catalogRevision: revision, activated: shouldActivate ? selected.map((tool) => tool.name) : [], tools: selected.map((tool) => ({ name: tool.name, description: tool.description, version: tool.version, schemaHash: tool.schemaHash, risk: tool.risk, executionKind: tool.executionKind, ...(name === 'tool_describe' ? { inputSchema: tool.inputSchema } : {}) })) }, null, 2) }
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) }
  }
}
