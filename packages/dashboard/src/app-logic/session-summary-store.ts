import type { SessionSummary } from '@agent-kernel/shared'

export class SessionSummaryStore {
  private readonly byId = new Map<string, SessionSummary>()
  private order: string[] = []

  replace(sessions: readonly SessionSummary[]): readonly SessionSummary[] {
    const nextIds = new Set(sessions.map((session) => session.sessionId))
    for (const id of this.byId.keys()) if (!nextIds.has(id)) this.byId.delete(id)
    this.order = sessions.map((session) => session.sessionId)
    for (const session of sessions) {
      const current = this.byId.get(session.sessionId)
      // server:sessions is throttled and can arrive after a newer per-session
      // state:changed event. Never let that stale snapshot clear a running state.
      const preserveNewerRunning = current && isRunning(current.status) && !isRunning(session.status) &&
        current.lastEventAt !== undefined && (session.lastEventAt === undefined || current.lastEventAt >= session.lastEventAt)
      this.set(preserveNewerRunning ? { ...session, status: current.status, lastEventAt: current.lastEventAt } : session)
    }
    return this.values()
  }

  update(sessionId: string, update: (summary: SessionSummary) => SessionSummary): readonly SessionSummary[] {
    const current = this.byId.get(sessionId)
    if (!current) return this.values()
    this.set(update(current))
    return this.values()
  }

  delete(sessionId: string): readonly SessionSummary[] {
    if (!this.byId.delete(sessionId)) return this.values()
    this.order = this.order.filter((id) => id !== sessionId)
    return this.values()
  }

  values(): readonly SessionSummary[] {
    return this.order.map((id) => this.byId.get(id)).filter((session): session is SessionSummary => session !== undefined)
  }

  clear(): void {
    this.byId.clear()
    this.order = []
  }

  private set(next: SessionSummary): void {
    const current = this.byId.get(next.sessionId)
    this.byId.set(next.sessionId, current && sameSummary(current, next) ? current : next)
  }
}

function isRunning(status: SessionSummary['status'] | undefined): boolean {
  return status === 'thinking' || status === 'executing_tools' || status === 'awaiting_approval'
}

function sameSummary(a: SessionSummary, b: SessionSummary): boolean {
  return a.sessionId === b.sessionId &&
    a.createdAt === b.createdAt &&
    a.lastEventAt === b.lastEventAt &&
    a.eventCount === b.eventCount &&
    a.parentSessionId === b.parentSessionId &&
    a.workspaceId === b.workspaceId &&
    a.workspaceName === b.workspaceName &&
    a.status === b.status &&
    a.queuedCount === b.queuedCount &&
    a.currentCwd === b.currentCwd &&
    a.firstUserMessage === b.firstUserMessage &&
    a.label === b.label &&
    a.preferences === b.preferences
}
