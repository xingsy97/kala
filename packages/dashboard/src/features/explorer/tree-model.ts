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
      workingDir: ex.workingDir,
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
