import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

import type { SessionNode } from './tree-model.js'
import type { SessionActivityStatus } from './Explorer.js'

/** Pure explorer comparators + status derivations (memo/identity helpers). */

export function isSessionWorkspaceOnline(session: SessionNode, onlineWorkspaceIds: ReadonlySet<string>): boolean {
  return session.workspaceId === undefined || onlineWorkspaceIds.has(session.workspaceId)
}

export function sameExecutorListForExplorer(prev: readonly AttachedExecutor[], next: readonly AttachedExecutor[]): boolean {
  if (prev === next) return true
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i]!
    const b = next[i]!
    if (a.executorId !== b.executorId ||
      a.workspaceId !== b.workspaceId ||
      a.workspaceName !== b.workspaceName ||
      a.hostname !== b.hostname ||
      a.os !== b.os ||
      a.runtime !== b.runtime ||
      a.runtimeVersion !== b.runtimeVersion ||
      a.defaultCwd !== b.defaultCwd ||
      a.workingDir !== b.workingDir ||
      a.ipAddresses?.[0] !== b.ipAddresses?.[0]) {
      return false
    }
  }
  return true
}

export function sameSessionListForExplorer(prev: readonly SessionSummary[], next: readonly SessionSummary[]): boolean {
  if (prev === next) return true
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i]!
    const b = next[i]!
    if (a.sessionId !== b.sessionId ||
      a.createdAt !== b.createdAt ||
      a.parentSessionId !== b.parentSessionId ||
      a.workspaceId !== b.workspaceId ||
      a.workspaceName !== b.workspaceName ||
      // Compare status coarsely: the raw status flips thinking↔executing_tools
      // many times during a tool-heavy turn, and although server:sessions is
      // throttled, each throttled push still carried a different raw status and
      // re-rendered the whole Explorer (re-running every row + restarting the
      // status spinner). The sidebar only distinguishes "running" vs the rest,
      // so treat all running states as equal here.
      coarseSummaryStatus(a.status) !== coarseSummaryStatus(b.status) ||
      a.currentCwd !== b.currentCwd ||
      a.firstUserMessage !== b.firstUserMessage ||
      a.label !== b.label) {
      return false
    }
  }
  return true
}

export function coarseSummaryStatus(status: SessionSummary['status'] | undefined): string {
  if (status === 'thinking' || status === 'executing_tools') return 'running'
  return status ?? 'unknown'
}

export function sameSessionStatusMap(
  prev: ReadonlyMap<string, SessionActivityStatus> | undefined,
  next: ReadonlyMap<string, SessionActivityStatus> | undefined,
): boolean {
  if (prev === next) return true
  if (!prev || !next) return false
  if (prev.size !== next.size) return false
  for (const [sessionId, status] of prev) {
    if (next.get(sessionId) !== status) return false
  }
  return true
}
