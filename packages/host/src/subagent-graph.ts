import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readSessionLog } from './store/log.js'

export type SubAgentGraph = {
  generatedAt: string
  nodes: Array<{
    sessionId: string
    parentSessionId?: string
    parentCursor?: number
    workspaceId?: string
    eventCount: number
  }>
  edges: Array<{
    parentSessionId: string
    childSessionId: string
    parentCursor?: number
  }>
  warnings: readonly string[]
}

export type ExportSubAgentGraphInput = {
  rootDir: string
  sessionsDir: string
}

export async function exportSubAgentGraph(
  input: ExportSubAgentGraphInput,
): Promise<{ graph: SubAgentGraph; graphPath: string }> {
  const warnings: string[] = []
  const nodes: SubAgentGraph['nodes'] = []
  const edges: SubAgentGraph['edges'] = []
  if (existsSync(input.sessionsDir)) {
    const files = (await readdir(input.sessionsDir)).filter((file) => file.endsWith('.jsonl')).sort()
    for (const file of files) {
      const path = join(input.sessionsDir, file)
      try {
        const parsed = await readSessionLog(path, { allowExternalRuntime: true })
        nodes.push({
          sessionId: parsed.header.sessionId,
          ...(parsed.header.parentSessionId ? { parentSessionId: parsed.header.parentSessionId } : {}),
          ...(parsed.header.parentCursor !== undefined ? { parentCursor: parsed.header.parentCursor } : {}),
          ...(parsed.header.workspaceId ? { workspaceId: parsed.header.workspaceId } : {}),
          eventCount: parsed.events.length,
        })
        if (parsed.header.parentSessionId) {
          edges.push({
            parentSessionId: parsed.header.parentSessionId,
            childSessionId: parsed.header.sessionId,
            ...(parsed.header.parentCursor !== undefined ? { parentCursor: parsed.header.parentCursor } : {}),
          })
        }
      } catch (err) {
        warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  nodes.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  edges.sort((a, b) => `${a.parentSessionId}:${a.childSessionId}`.localeCompare(`${b.parentSessionId}:${b.childSessionId}`))
  const graph: SubAgentGraph = { generatedAt: new Date().toISOString(), nodes, edges, warnings }
  await mkdir(input.rootDir, { recursive: true })
  const graphPath = join(input.rootDir, 'subagent-graph.json')
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  return { graph, graphPath }
}
