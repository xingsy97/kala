import type { SessionSummary } from '@agent-kernel/shared'

const RECENT_SESSION_WINDOW_MS = 48 * 60 * 60 * 1000

export function recentEmptyStateSessions(
  sessions: readonly SessionSummary[],
  currentSessionId: string | null,
  now = Date.now(),
): SessionSummary[] {
  const cutoff = now - RECENT_SESSION_WINDOW_MS
  return sessions
    .filter((session) => session.sessionId !== currentSessionId)
    .map((session) => ({ session, updatedAt: Date.parse(session.lastEventAt ?? session.createdAt) }))
    .filter(({ updatedAt }) => Number.isFinite(updatedAt) && updatedAt >= cutoff && updatedAt <= now)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map(({ session }) => session)
}
