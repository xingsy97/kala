import type { TimelineEntry } from '../../session.js'

export type TaskGraphStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type TaskGraphNode = { id: string; content: string; status: TaskGraphStatus; priority?: 'high' | 'medium' | 'low' }
export type TaskGraphEdge = { from: string; to: string }
export type TaskGraphSnapshot = {
  version: 1
  revision: number
  nodes: readonly TaskGraphNode[]
  edges: readonly TaskGraphEdge[]
  summary: { total: number; completed: number; active: number; ready: number; blocked: number; cancelled: number }
  ready: readonly string[]
  blocked: readonly { id: string; waitingOn: readonly string[] }[]
}

export function taskGraphFromTimeline(timeline: readonly TimelineEntry[]): TaskGraphSnapshot | null {
  const calls = new Map<string, string>()
  let current: TaskGraphSnapshot | null = null
  for (const entry of timeline) {
    for (const effect of entry.effects) {
      if (effect.kind === 'call_tool') calls.set(effect.callId, effect.name)
    }
    if (entry.event.kind !== 'tool_result' || !entry.event.ok || calls.get(entry.event.callId) !== 'todo_graph') continue
    const parsed = parseTaskGraphSnapshot(entry.event.content)
    if (parsed) current = parsed
  }
  return current
}

export function parseTaskGraphSnapshot(content: string): TaskGraphSnapshot | null {
  try {
    const value = JSON.parse(content) as TaskGraphSnapshot
    if (value?.version !== 1 || !Number.isInteger(value.revision) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null
    if (!value.summary || !Array.isArray(value.ready) || !Array.isArray(value.blocked)) return null
    if (value.nodes.some((node) => !node || typeof node.id !== 'string' || typeof node.content !== 'string' || !['pending', 'in_progress', 'completed', 'cancelled'].includes(node.status))) return null
    if (value.edges.some((edge) => !edge || typeof edge.from !== 'string' || typeof edge.to !== 'string')) return null
    return value
  } catch {
    return null
  }
}
