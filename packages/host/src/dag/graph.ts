import type { DagEdge, DagNode, DagNodeStatus, DagPlanEdgeInput } from '@agent-kernel/shared'

export class DagGraphError extends Error {}

const NODE_TRANSITIONS: Readonly<Record<DagNodeStatus, readonly DagNodeStatus[]>> = {
  pending: ['ready', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['ready', 'waiting_user', 'succeeded', 'failed', 'cancelled', 'replaced'],
  waiting_user: ['ready', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  replaced: [],
}

export function assertDag(nodeIds: readonly string[], edges: readonly DagPlanEdgeInput[]): void {
  const ids = new Set(nodeIds)
  if (ids.size !== nodeIds.length) throw new DagGraphError('DAG node IDs must be unique')
  const indegree = new Map(nodeIds.map((id) => [id, 0]))
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]))
  const edgeKeys = new Set<string>()
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new DagGraphError('DAG edge references an unknown node')
    if (edge.source === edge.target) throw new DagGraphError('DAG self edges are not allowed')
    const key = `${edge.source}\u0000${edge.target}`
    if (edgeKeys.has(key)) throw new DagGraphError('DAG edges must be unique')
    edgeKeys.add(key)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.get(edge.source)!.push(edge.target)
  }
  const queue = nodeIds.filter((id) => indegree.get(id) === 0)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    visited += 1
    for (const target of outgoing.get(id) ?? []) {
      const next = indegree.get(target)! - 1
      indegree.set(target, next)
      if (next === 0) queue.push(target)
    }
  }
  if (visited !== nodeIds.length) throw new DagGraphError('DAG must be acyclic')
}

export function assertSingleEntryReachability(
  nodeIds: readonly string[],
  edges: readonly DagPlanEdgeInput[],
): string {
  assertDag(nodeIds, edges)
  const targets = new Set(edges.map((edge) => edge.target))
  const entries = nodeIds.filter((id) => !targets.has(id))
  if (entries.length !== 1) throw new DagGraphError('DAG replacement patch must have exactly one entry node')
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]))
  for (const edge of edges) outgoing.get(edge.source)!.push(edge.target)
  const reachable = new Set<string>()
  const queue = [entries[0]!]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (reachable.has(id)) continue
    reachable.add(id)
    queue.push(...(outgoing.get(id) ?? []))
  }
  if (reachable.size !== nodeIds.length) throw new DagGraphError('DAG replacement nodes must be reachable from its entry')
  return entries[0]!
}

export function assertNodeTransition(from: DagNodeStatus, to: DagNodeStatus): void {
  if (!NODE_TRANSITIONS[from].includes(to)) {
    throw new DagGraphError(`Cannot transition DAG node from ${from} to ${to}`)
  }
}

export function readyNodeIds(nodes: readonly DagNode[], edges: readonly DagEdge[]): readonly string[] {
  const completed = new Set(nodes
    .filter((node) => node.status === 'succeeded' || node.status === 'replaced')
    .map((node) => node.id))
  return nodes
    .filter((node) => node.status === 'pending' || node.status === 'ready')
    .filter((node) => edges
      .filter((edge) => edge.target === node.id)
      .every((edge) => completed.has(edge.source)))
    .map((node) => node.id)
}

export function scopesConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => scopeContains(a, b) || scopeContains(b, a)))
}

function scopeContains(parent: string, child: string): boolean {
  const normalizedParent = normalizeScope(parent)
  const normalizedChild = normalizeScope(child)
  return normalizedParent === '.'
    || normalizedParent === normalizedChild
    || normalizedChild.startsWith(`${normalizedParent}/`)
}

function normalizeScope(scope: string): string {
  const normalized = scope.trim().replaceAll('\\', '/').replace(/^\.\/+/u, '').replace(/\/+$/u, '')
  if (!normalized || normalized === '.') return '.'
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new DagGraphError(`Invalid DAG write scope: ${scope}`)
  }
  return normalized
}
