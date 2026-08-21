import type { QueuedMessagePreview, SessionSummary } from '@agent-kernel/shared'
import type { TimelineEntry } from '../session.js'

/**
 * Pure selectors/derivations over session lists + the optimistic queued-message
 * reconciliation. Extracted from app.tsx for isolated unit testing.
 */

export function mergeOptimisticQueuedMessages(
  serverMessages: readonly QueuedMessagePreview[],
  optimisticMessages: readonly QueuedMessagePreview[],
): readonly QueuedMessagePreview[] {
  if (optimisticMessages.length === 0) return serverMessages
  const serverKeys = new Set(serverMessages.map((item) => queuedMessageKey(item)))
  return [
    ...serverMessages,
    ...optimisticMessages.filter((item) => !serverKeys.has(queuedMessageKey(item))),
  ]
}

export function reconcileOptimisticQueuedMessages(
  optimisticMessages: readonly QueuedMessagePreview[],
  serverMessages: readonly QueuedMessagePreview[],
  timeline: readonly TimelineEntry[] = [],
): readonly QueuedMessagePreview[] {
  if (optimisticMessages.length === 0) return optimisticMessages
  const serverKeys = new Set(serverMessages.map((item) => queuedMessageKey(item)))
  const ackedUserTexts = new Map<string, number[]>()
  for (const entry of timeline) {
    if (entry.event.kind !== 'user_message') continue
    const text = entry.event.text ?? entry.event.content?.map((part) => part.type === 'text' ? part.text : '').join('') ?? ''
    const ts = Date.parse(entry.ts)
    const bucket = ackedUserTexts.get(text) ?? []
    bucket.push(Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY)
    ackedUserTexts.set(text, bucket)
  }
  const next = optimisticMessages.filter((item) => {
    if (serverKeys.has(queuedMessageKey(item))) return false
    const bucket = ackedUserTexts.get(item.text)
    if (!bucket || bucket.length === 0) return true
    const createdAt = Date.parse(item.createdAt)
    const minTs = Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY
    const index = bucket.findIndex((ts) => ts >= minTs)
    if (index === -1) return true
    bucket.splice(index, 1)
    return false
  })
  return next.length === optimisticMessages.length ? optimisticMessages : next
}

export function queuedMessageKey(item: QueuedMessagePreview): string {
  const attachments = item.content?.map((part) => part.type === 'image'
    ? `image:${JSON.stringify(part.source)}`
    : part.type === 'text'
      ? `text:${part.text}`
      : part.type).join('|') ?? ''
  return `${item.mode}\u0000${item.text}\u0000${attachments}`
}

export function sessionExists(
  sessions: readonly SessionSummary[],
  sessionId: string | null | undefined,
): boolean {
  return Boolean(sessionId && sessions.some((s) => s.sessionId === sessionId))
}

export function sessionDisplayLabel(session: SessionSummary | undefined, fallback: string): string {
  const label = session?.label?.trim() || session?.firstUserMessage?.trim() || fallback
  return label.length > 40 ? `${label.slice(0, 40)}…` : label
}

export function sessionIdsForCacheInvalidation(
  sessions: readonly SessionSummary[],
  rootSessionId: string,
): readonly string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentSessionId) continue
    const children = childrenByParent.get(session.parentSessionId) ?? []
    children.push(session.sessionId)
    childrenByParent.set(session.parentSessionId, children)
  }
  const out: string[] = []
  const seen = new Set<string>()
  const queue = [rootSessionId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    queue.push(...(childrenByParent.get(id) ?? []))
  }
  return out
}

export function removedSessionIds(
  previousIds: ReadonlySet<string>,
  nextIds: ReadonlySet<string>,
): readonly string[] {
  const removed: string[] = []
  for (const id of previousIds) {
    if (!nextIds.has(id)) removed.push(id)
  }
  return removed
}

export function nextSessionSelection({
  sessions,
  currentSessionId,
  explicit,
  pendingSessionId = null,
}: {
  sessions: readonly SessionSummary[]
  currentSessionId: string | null
  explicit: boolean
  pendingSessionId?: string | null
}): SessionSummary | null {
  if (sessions.length === 0) return null
  if (currentSessionId === null) return null
  if (currentSessionId === pendingSessionId) return null
  const currentExists = sessionExists(sessions, currentSessionId)
  if (explicit && currentExists) return null
  const candidates = currentExists ? sessions : sessions.filter((s) => s.sessionId !== currentSessionId)
  return candidates.find((s) => s.eventCount > 0) ?? candidates[0] ?? null
}
