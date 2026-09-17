import { deriveSessionState, type SessionSummary } from '@agent-kernel/shared'
import type { DesktopActivity } from '../lib/desktop-bridge.js'
import { decideInactiveSummaryNotification } from './notification-policy.js'

export type DesktopSessionSignal = { session: SessionSummary; kind: 'approval_required' | 'session_error' | 'waiting_for_user'; id: string }
type Input = { sessions: readonly SessionSummary[]; subAgentSessionIds?: ReadonlySet<string>; unresolvedSessionIds?: ReadonlySet<string>; activeSessionId: string | null; focused: boolean; visible: boolean; ready: boolean; now: number }

/** Transition-only native signals: no history replay, no queued/intermediate completion. */
export class DesktopActivityTracker {
  private previous = new Map<string, SessionSummary>()
  private attention = new Set<string>()
  private completed = new Set<string>()
  private pending = new Map<string, { at: number; session: SessionSummary }>()
  private deferredAttention = new Map<string, DesktopSessionSignal>()
  private unresolved: ReadonlySet<string> = new Set()
  private initialized = false
  private signalSequence = 0

  update(input: Input): { activity: DesktopActivity; signals: DesktopSessionSignal[] } {
    const signals: DesktopSessionSignal[] = []
    this.unresolved = input.unresolvedSessionIds ?? new Set()
    // parentSessionId also marks user forks; exclude only positively identified tool subagents.
    const sessions = input.sessions.filter((session) => !input.subAgentSessionIds?.has(session.sessionId)).map((session) => {
      const previous = this.previous.get(session.sessionId)
      return previous && session.eventCount < previous.eventCount ? previous : session
    })
    const liveIds = new Set(sessions.map((session) => session.sessionId))
    const viewed = input.focused && input.visible ? input.activeSessionId : null
    for (const id of [...this.attention, ...this.completed, ...this.pending.keys(), ...this.deferredAttention.keys()]) {
      if (!liveIds.has(id)) { this.attention.delete(id); this.completed.delete(id); this.pending.delete(id); this.deferredAttention.delete(id) }
    }
    if (!input.ready) {
      this.initialized = false
      this.pending.clear()
      this.deferredAttention.clear()
      return { activity: this.aggregate(sessions), signals }
    }
    for (const session of sessions) {
      const id = session.sessionId
      const before = this.previous.get(id)
      const derived = deriveSessionState({ status: session.status })
      const running = derived.isRunning || (session.queuedCount ?? 0) > 0
      const resting = session.status === 'done' || session.status === 'idle'
      const unresolved = this.unresolved.has(id)
      if (running || !resting) this.pending.delete(id)
      if (running) { this.completed.delete(id); this.attention.delete(id); this.deferredAttention.delete(id) }
      if (!derived.isWaitingForUser && derived.activity !== 'failed') this.deferredAttention.delete(id)
      if (!this.initialized) {
        if (derived.isWaitingForUser || derived.activity === 'failed') this.attention.add(id)
      } else if (before) {
        const decision = decideInactiveSummaryNotification({
          previousStatus: (before.queuedCount ?? 0) > 0 ? 'thinking' : before.status, nextStatus: session.status,
          focusedSessionId: viewed, eventSessionId: id, queuedCount: session.queuedCount,
        })
        if (decision.notify && decision.reason === 'background_session_completed') this.pending.set(id, { at: input.now + 1500, session })
        if (before.status !== session.status && (derived.isWaitingForUser || derived.activity === 'failed') && id !== viewed) {
          this.attention.add(id)
          const signal: DesktopSessionSignal = { session, kind: derived.isWaitingForUser ? 'approval_required' : 'session_error', id: `${id}:${session.eventCount}:${session.status}:${++this.signalSequence}` }
          if (unresolved) this.deferredAttention.set(id, signal)
          else { this.deferredAttention.delete(id); signals.push(signal) }
        }
      }
      const deferred = this.deferredAttention.get(id)
      if (deferred && !unresolved) {
        this.deferredAttention.delete(id)
        if (id !== viewed) signals.push(deferred)
      }
      const pending = this.pending.get(id)
      if (pending && input.now >= pending.at && resting && !running && !unresolved) {
        this.pending.delete(id)
        if (id !== viewed) {
          this.completed.add(id)
          // State-only runtimes may finish another turn without a summary eventCount change.
          signals.push({ session, kind: 'waiting_for_user', id: `${id}:${session.eventCount}:completed:${++this.signalSequence}` })
        }
      }
      if (id === viewed) { this.attention.delete(id); this.completed.delete(id); this.pending.delete(id); this.deferredAttention.delete(id) }
    }
    this.previous = new Map(sessions.map((session) => [session.sessionId, session]))
    this.initialized = true
    return { activity: this.aggregate(sessions), signals }
  }

  get nextDeadline(): number | null {
    const pending = [...this.pending.entries()].filter(([id]) => !this.unresolved.has(id))
    return pending.length ? Math.min(...pending.map(([, value]) => value.at)) : null
  }

  private aggregate(sessions: readonly SessionSummary[]): DesktopActivity {
    const running = sessions.filter((session) => !this.unresolved.has(session.sessionId) && (deriveSessionState({ status: session.status }).isRunning || (session.queuedCount ?? 0) > 0)).length
    const attention = [...this.attention].filter((id) => !this.unresolved.has(id)).length, completed = [...this.completed].filter((id) => !this.unresolved.has(id)).length
    return { status: attention ? 'attention' : running ? 'running' : completed ? 'completed' : 'idle', running, attention, completed }
  }
}
