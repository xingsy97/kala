/**
 * Pure tree-shaping for the Explorer view: fold (executors, sessions) into a
 * two-level hierarchy  -  workspace parents with session children.
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
}

export type TreeNode = WorkspaceNode | SessionNode

const UNASSIGNED_KEY = '__unassigned__'

export function buildTree(
  executors: readonly AttachedExecutor[],
  sessions: readonly SessionSummary[],
): WorkspaceNode[] {
  const buckets = new Map<string, WorkspaceNode>()

  for (const ex of executors) {
    if (!ex.workspaceId) continue
    if (buckets.has(ex.workspaceId)) continue
    buckets.set(ex.workspaceId, {
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

  for (const s of sessions) {
    const node = sessionNode(s)
    const key = s.workspaceId ?? UNASSIGNED_KEY
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        id: key === UNASSIGNED_KEY ? 'ws:unassigned' : `ws:${key}`,
        kind: 'workspace',
        workspaceId: key === UNASSIGNED_KEY ? null : key,
        name:
          key === UNASSIGNED_KEY
            ? 'Unassigned'
            : s.workspaceName ?? '(unnamed workspace)',
        online: false,
        children: [],
      }
      buckets.set(key, bucket)
    }
    bucket.children.push(node)
  }

  for (const bucket of buckets.values()) {
    bucket.children.sort((a, b) =>
      b.lastActivityIso.localeCompare(a.lastActivityIso),
    )
  }

  return [...buckets.values()].sort(compareWorkspaces)
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
  }
}

function labelFor(s: SessionSummary): string {
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
