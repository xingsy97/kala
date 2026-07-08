/**
 * Pure tree-shaping for the Explorer view: fold (executors, sessions) into a
 * hierarchy  -  workspace parents, optional time-bucket groups, session leaves.
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

export type TimeBucketKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'older'

export type TimeBucketNode = {
  id: string
  kind: 'bucket'
  bucket: TimeBucketKey
  label: string
  children: SessionNode[]
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
   * nest directly under the parent  -  they bypass time-bucketing because a
   * fork's structural home is its parent, not its own activity bucket.
   */
  children: SessionNode[]
}

export type WorkspaceChild = TimeBucketNode | SessionNode
export type TreeNode = WorkspaceNode | TimeBucketNode | SessionNode

const UNASSIGNED_KEY = '__unassigned__'

const BUCKET_ORDER: readonly TimeBucketKey[] = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'older',
]

const BUCKET_LABEL: Record<TimeBucketKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Previous 7 days',
  last30: 'Previous 30 days',
  older: 'Older',
}

/** Sessions per workspace below this stay flat  -  bucketing 1 - 2 items is noise. */
const BUCKET_THRESHOLD = 3

export type BuildTreeOptions = {
  /** Injected clock for deterministic tests. Defaults to `Date.now()`. */
  now?: () => number
}

export function buildTree(
  executors: readonly AttachedExecutor[],
  sessions: readonly SessionSummary[],
  options: BuildTreeOptions = {},
): WorkspaceNode[] {
  const now = options.now ?? Date.now
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
    workspace.children =
      roots.length >= BUCKET_THRESHOLD
        ? groupByTime(roots, now())
        : roots
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

  sortSessionsByActivity(roots)
  for (const node of sessions) sortSessionsByActivity(node.children)
  return roots
}

function sortSessionsByActivity(sessions: SessionNode[]): void {
  sessions.sort((a, b) => b.lastActivityIso.localeCompare(a.lastActivityIso))
}

export function groupByTime(
  sessions: readonly SessionNode[],
  nowMs: number,
): TimeBucketNode[] {
  const grouped = new Map<TimeBucketKey, SessionNode[]>()
  for (const s of sessions) {
    const key = classify(s.lastActivityIso, nowMs)
    const list = grouped.get(key) ?? []
    list.push(s)
    grouped.set(key, list)
  }
  const nodes: TimeBucketNode[] = []
  for (const key of BUCKET_ORDER) {
    const list = grouped.get(key)
    if (!list || list.length === 0) continue
    nodes.push({
      id: `bucket:${key}`,
      kind: 'bucket',
      bucket: key,
      label: BUCKET_LABEL[key],
      children: list,
    })
  }
  return nodes
}

function classify(iso: string, nowMs: number): TimeBucketKey {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'older'
  const now = new Date(nowMs)
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  )
  const dayMs = 86_400_000
  if (t >= startOfToday) return 'today'
  if (t >= startOfToday - dayMs) return 'yesterday'
  if (t >= startOfToday - 7 * dayMs) return 'last7'
  if (t >= startOfToday - 30 * dayMs) return 'last30'
  return 'older'
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
    return override.length > 40 ? `${override.slice(0, 40)} - ` : override
  }
  const raw = s.firstUserMessage
  if (!raw) return `new session  -  ${s.sessionId.slice(0, 6)}`
  return raw.length > 40 ? `${raw.slice(0, 40)} - ` : raw
}

function compareWorkspaces(a: WorkspaceNode, b: WorkspaceNode): number {
  const aUnassigned = a.workspaceId === null
  const bUnassigned = b.workspaceId === null
  if (aUnassigned !== bUnassigned) return aUnassigned ? 1 : -1
  if (a.online !== b.online) return a.online ? -1 : 1
  return a.name.localeCompare(b.name)
}
