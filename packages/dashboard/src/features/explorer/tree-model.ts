/**
 * Pure tree-shaping for the Explorer view: fold (executors, sessions) into a
 * hierarchy — workspace parents with flat session leaves.
 *
 * Kept DOM-free so we can unit-test grouping and sort order without a
 * component harness. Explorer.tsx feeds the output directly to react-arborist.
 */

import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

export type WorkspaceNode = {
  id: string
  kind: 'workspace'
  workspaceId: string | null
  name: string
  online: boolean
  os?: string
  runtime?: string
  runtimeVersion?: string
  ip?: string
  workingDir?: string
  children: WorkspaceChild[]
}

export type SessionNode = {
  id: string
  kind: 'session'
  sessionId: string
  workspaceId?: string
  label: string
  status?: SessionSummary['status']
  currentCwd?: string
  eventCount: number
  parentSessionId?: string
  lastActivityIso: string
  /**
   * Forked children. A session is a child of another when its
   * `parentSessionId` matches a session in the same workspace. Children
   * nest directly under the parent so fork relationships stay visible.
   */
  children: SessionNode[]
}

export type WorkspaceChild = SessionNode
export type TreeNode = WorkspaceNode | SessionNode

export type SessionRuntimeMeta = {
  status?: SessionSummary['status']
  currentCwd?: string
  lastActivityIso: string
}

const UNASSIGNED_KEY = '__unassigned__'

export type BuildTreeOptions = {
  /** Injected clock for deterministic tests. Defaults to `Date.now()`. */
  now?: () => number
}

export function buildTree(
  executors: readonly AttachedExecutor[],
  sessions: readonly SessionSummary[],
  options: BuildTreeOptions = {},
): WorkspaceNode[] {
  void options
  const workspacesByKey = new Map<string, WorkspaceNode>()

  for (const ex of executors) {
    if (!ex.workspaceId) continue
    if (workspacesByKey.has(ex.workspaceId)) continue
    workspacesByKey.set(ex.workspaceId, {
      id: `ws:${ex.workspaceId}`,
      kind: 'workspace',
      workspaceId: ex.workspaceId,
      name: ex.workspaceName ?? ex.hostname ?? ex.executorId,
      online: true,
      os: ex.os,
      runtime: ex.runtime,
      runtimeVersion: ex.runtimeVersion,
      ip: ex.ipAddresses?.[0],
      workingDir: ex.defaultCwd ?? ex.workingDir,
      children: [],
    })
  }

  const sessionsByWorkspace = new Map<string, SessionNode[]>()
  const allNodes = new Map<string, SessionNode>()
  const workspaceKeyBySession = new Map<string, string>()
  for (const s of sessions) {
    const node = sessionNode(s)
    allNodes.set(s.sessionId, node)
    const key = s.workspaceId ?? UNASSIGNED_KEY
    workspaceKeyBySession.set(s.sessionId, key)
    if (!workspacesByKey.has(key)) {
      workspacesByKey.set(key, {
        id: key === UNASSIGNED_KEY ? 'ws:unassigned' : `ws:${key}`,
        kind: 'workspace',
        workspaceId: key === UNASSIGNED_KEY ? null : key,
        name:
          key === UNASSIGNED_KEY
            ? 'Unassigned'
            : s.workspaceName ?? '(unnamed workspace)',
        online: false,
        children: [],
      })
    }
    const workspaceSessions = sessionsByWorkspace.get(key) ?? []
    workspaceSessions.push(node)
    sessionsByWorkspace.set(key, workspaceSessions)
  }

  for (const [key, workspaceSessions] of sessionsByWorkspace) {
    const roots = nestForkedSessions(workspaceSessions, key, allNodes, workspaceKeyBySession)
    const workspace = workspacesByKey.get(key)
    if (!workspace) continue
    workspace.children = roots
  }

  return [...workspacesByKey.values()].sort(compareWorkspaces)
}

export function buildInitialOpenState(
  workspaces: readonly WorkspaceNode[],
  workspaceOpenState: Record<string, boolean>,
  sessionChildrenOpenState: Record<string, boolean>,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...workspaceOpenState }
  const visitSession = (session: SessionNode): void => {
    if (session.children.length > 0) {
      out[session.id] = sessionChildrenOpenState[session.id] ?? false
      session.children.forEach(visitSession)
    }
  }
  for (const workspace of workspaces) {
    out[workspace.id] = workspaceOpenState[workspace.id] ?? true
    workspace.children.forEach(visitSession)
  }
  return out
}

export function sessionStructureKeyFor(session: SessionSummary): string {
  return [
    session.sessionId,
    session.workspaceId ?? '',
    session.workspaceName ?? '',
    session.parentSessionId ?? '',
    session.firstUserMessage ?? '',
    session.label ?? '',
    session.createdAt,
  ].join('\u001e')
}

export function toStructuralSessionSummary(session: SessionSummary): SessionSummary {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    eventCount: 0,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(session.workspaceName ? { workspaceName: session.workspaceName } : {}),
    ...(session.firstUserMessage ? { firstUserMessage: session.firstUserMessage } : {}),
    ...(session.label !== undefined ? { label: session.label } : {}),
  }
}

export function runtimeMetaFor(session: SessionSummary): SessionRuntimeMeta {
  return {
    status: session.status,
    currentCwd: session.currentCwd,
    lastActivityIso: session.lastEventAt ?? session.createdAt,
  }
}

export function syncWorkspaceOrder(
  prev: readonly string[],
  workspaces: readonly WorkspaceNode[],
): readonly string[] {
  const ids = workspaces
    .map((workspace) => workspace.workspaceId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return syncIdOrder(prev, ids)
}

export function applyManualWorkspaceOrder(
  workspaces: readonly WorkspaceNode[],
  order: readonly string[],
): readonly WorkspaceNode[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...workspaces].sort((a, b) => {
    if (a.workspaceId === null || b.workspaceId === null) {
      if (a.workspaceId === b.workspaceId) return 0
      return a.workspaceId === null ? 1 : -1
    }
    const ar = rank.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER
    const br = rank.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER
    return ar - br
  })
}

export function reorderWorkspaceIds(
  order: readonly string[],
  targetIds: readonly string[],
  movedIds: readonly string[],
  targetIndex: number,
): readonly string[] {
  void order
  return reorderContiguousIds(targetIds, movedIds, targetIndex)
}

export function canDropWorkspacesAtRoot(input: {
  parentNode: { id: string; isRoot: boolean } | null
  dragNodes: readonly { data: Pick<WorkspaceNode, 'kind' | 'workspaceId'> }[]
}): boolean {
  return isRootDropParent(input.parentNode) && input.dragNodes.every((node) => node.data.kind === 'workspace' && node.data.workspaceId !== null)
}

export function syncSessionOrder(
  prev: readonly string[],
  sessions: readonly SessionSummary[],
): readonly string[] {
  return syncIdOrder(prev, sessions.map((s) => s.sessionId))
}

export function applyManualSessionOrder(
  sessions: readonly SessionSummary[],
  order: readonly string[],
): readonly SessionSummary[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...sessions].sort((a, b) => {
    const ar = rank.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER
    const br = rank.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER
    return ar - br
  })
}

export function reorderSessionIds(
  order: readonly string[],
  targetIds: readonly string[],
  movedIds: readonly string[],
  targetIndex: number,
): readonly string[] {
  const moved = new Set(movedIds)
  const target = new Set(targetIds)
  const targetWithoutMoved = targetIds.filter((id) => !moved.has(id))
  const insertIndex = Math.max(0, Math.min(targetIndex, targetWithoutMoved.length))
  const reorderedTarget = [
    ...targetWithoutMoved.slice(0, insertIndex),
    ...movedIds,
    ...targetWithoutMoved.slice(insertIndex),
  ]
  let cursor = 0
  return order.map((id) => {
    if (!target.has(id)) return id
    return reorderedTarget[cursor++] ?? id
  })
}

export function countSessionDescendants(session: SessionNode): number {
  let count = 0
  for (const child of session.children) {
    count += 1 + countSessionDescendants(child)
  }
  return count
}

export function filterTree(nodes: readonly WorkspaceNode[], query: string): WorkspaceNode[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...nodes]
  const filtered: WorkspaceNode[] = []
  for (const workspace of nodes) {
    const workspaceMatches = workspaceMatchesQuery(workspace, needle)
    const children: WorkspaceChild[] = []
    for (const child of workspace.children) {
      const kept = filterSessionSubtree(child, needle, workspaceMatches)
      if (kept) children.push(kept)
    }
    if (workspaceMatches || children.length > 0) filtered.push({ ...workspace, children })
  }
  return filtered
}

export function isRootDropParent(node: { id: string; isRoot: boolean } | null): boolean {
  return node === null || node.isRoot || node.id === '__REACT_ARBORIST_INTERNAL_ROOT__'
}

function syncIdOrder(prev: readonly string[], ids: readonly string[]): readonly string[] {
  const live = new Set(ids)
  const next = prev.filter((id) => live.has(id))
  const seen = new Set(next)
  for (const id of ids) {
    if (!seen.has(id)) next.push(id)
  }
  return next
}

function reorderContiguousIds(
  targetIds: readonly string[],
  movedIds: readonly string[],
  targetIndex: number,
): readonly string[] {
  const moved = new Set(movedIds)
  const targetWithoutMoved = targetIds.filter((id) => !moved.has(id))
  const insertIndex = Math.max(0, Math.min(targetIndex, targetWithoutMoved.length))
  return [
    ...targetWithoutMoved.slice(0, insertIndex),
    ...movedIds,
    ...targetWithoutMoved.slice(insertIndex),
  ]
}

/**
 * Keeps a session if it or any descendant matches the query. When a parent
 * only exists to house a matching child, we still return the parent so the
 * user sees the fork relationship.
 */
function filterSessionSubtree(
  session: SessionNode,
  needle: string,
  workspaceMatches: boolean,
): SessionNode | null {
  const keptChildren: SessionNode[] = []
  for (const child of session.children) {
    const kept = filterSessionSubtree(child, needle, workspaceMatches)
    if (kept) keptChildren.push(kept)
  }
  const selfMatches = workspaceMatches || sessionMatchesQuery(session, needle)
  if (!selfMatches && keptChildren.length === 0) return null
  return { ...session, children: keptChildren }
}

function workspaceMatchesQuery(workspace: WorkspaceNode, needle: string): boolean {
  return [workspace.name, workspace.workspaceId, workspace.os, workspace.runtime, workspace.runtimeVersion, workspace.ip]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => value.toLocaleLowerCase().includes(needle))
}

function sessionMatchesQuery(session: SessionNode, needle: string): boolean {
  return [session.label, session.sessionId, session.workspaceId, session.currentCwd, session.status, session.parentSessionId]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => value.toLocaleLowerCase().includes(needle))
}

function nestForkedSessions(
  sessions: readonly SessionNode[],
  workspaceKey: string,
  allNodes: ReadonlyMap<string, SessionNode>,
  workspaceKeyBySession: ReadonlyMap<string, string>,
): SessionNode[] {
  const roots: SessionNode[] = []

  for (const node of sessions) {
    const parentId = node.parentSessionId
    const parent = parentId ? allNodes.get(parentId) : undefined
    const parentWorkspaceKey = parentId ? workspaceKeyBySession.get(parentId) : undefined

    // Missing parents and cross-workspace parents stay visible as roots.
    if (parent && parentWorkspaceKey === workspaceKey) parent.children.push(node)
    else roots.push(node)
  }

  return roots
}

function sessionNode(s: SessionSummary): SessionNode {
  return {
    id: `sess:${s.sessionId}`,
    kind: 'session',
    sessionId: s.sessionId,
    workspaceId: s.workspaceId,
    label: labelFor(s),
    status: s.status,
    currentCwd: s.currentCwd,
    eventCount: s.eventCount,
    parentSessionId: s.parentSessionId,
    lastActivityIso: s.lastEventAt ?? s.createdAt,
    children: [],
  }
}

function labelFor(s: SessionSummary): string {
  const override = s.label?.trim()
  if (override && override.length > 0) {
    return override.length > 40 ? `${override.slice(0, 40)}…` : override
  }
  const raw = s.firstUserMessage
  if (!raw) return `new session · ${s.sessionId.slice(0, 6)}`
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw
}

function compareWorkspaces(a: WorkspaceNode, b: WorkspaceNode): number {
  const aUnassigned = a.workspaceId === null
  const bUnassigned = b.workspaceId === null
  if (aUnassigned !== bUnassigned) return aUnassigned ? 1 : -1
  if (a.online !== b.online) return a.online ? -1 : 1
  return a.name.localeCompare(b.name)
}
