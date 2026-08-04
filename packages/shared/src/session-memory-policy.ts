/**
 * Product-owned policy controlling which durable memory scopes a Session may
 * read. It is independent of any evaluation or benchmark representation.
 */
export type SessionMemoryPolicy = {
  mode: 'disabled' | 'workspace_only' | 'workspace_and_global' | 'snapshot_pinned'
  includeGlobal: boolean
  snapshotRef?: string
  workspaceRoot?: string
  entryCount?: number
  tombstoneCount?: number
  generatedAt?: string
  reasonCodes: readonly string[]
}

export type SessionMemoryPolicyInput = {
  mode?: SessionMemoryPolicy['mode']
  includeGlobal?: boolean
  snapshotRef?: string
  workspaceRoot?: string
  memoryIndex?: {
    generatedAt?: string
    entries?: readonly { status?: string }[]
  }
  crossTaskIsolation?: boolean
}

export function deriveSessionMemoryPolicy(input: SessionMemoryPolicyInput = {}): SessionMemoryPolicy {
  const includeGlobal = input.includeGlobal ?? false
  const explicit = input.mode
  const mode: SessionMemoryPolicy['mode'] = explicit
    ?? (input.crossTaskIsolation
      ? 'disabled'
      : input.snapshotRef
        ? 'snapshot_pinned'
        : includeGlobal
          ? 'workspace_and_global'
          : 'workspace_only')
  const reasonCodes: string[] = [`memory_mode:${mode}`]
  if (input.crossTaskIsolation) reasonCodes.push('cross_task_isolation')
  if (mode === 'disabled') reasonCodes.push('memory_disabled')
  if (includeGlobal) reasonCodes.push('global_included')
  if (input.snapshotRef) reasonCodes.push('snapshot_pinned')

  const entries = input.memoryIndex?.entries ?? []
  const active = entries.filter((entry) => (entry.status ?? 'active') === 'active').length
  const tombstoned = entries.filter((entry) => entry.status === 'tombstoned').length

  return {
    mode,
    includeGlobal,
    ...(input.snapshotRef ? { snapshotRef: input.snapshotRef } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.memoryIndex ? { entryCount: active, tombstoneCount: tombstoned } : {}),
    ...(input.memoryIndex?.generatedAt ? { generatedAt: input.memoryIndex.generatedAt } : {}),
    reasonCodes,
  }
}
