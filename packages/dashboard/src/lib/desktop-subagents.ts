import type { SessionSummary, SubAgentListResult } from '@agent-kernel/shared'

type ParentClassification = {
  children: readonly string[]
  signature: string
  phase: 'pending' | 'retrying' | 'resolved' | 'failed'
  attempts: number
  due: number
  inFlight: boolean
  subagents: Set<string>
}

/** Bounded read-only classification: fork parenthood alone is never subagent evidence. */
export class DesktopSubagentClassifier {
  private parents = new Map<string, ParentClassification>()
  private inFlight = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private disposed = false

  constructor(
    private query: (parentSessionId: string) => Promise<SubAgentListResult>,
    private onChange: () => void,
    private onError: (error: Error) => void,
  ) {}

  update(sessions: readonly SessionSummary[]): void {
    const next = new Map<string, string[]>()
    for (const session of sessions) {
      if (session.parentSessionId) next.set(session.parentSessionId, [...(next.get(session.parentSessionId) ?? []), session.sessionId])
    }
    let changed = false
    for (const parent of this.parents.keys()) {
      if (!next.has(parent)) { this.parents.delete(parent); changed = true }
    }
    for (const [parent, children] of next) {
      const signature = children.sort().join('|')
      if (this.parents.get(parent)?.signature === signature) continue
      this.parents.set(parent, { children, signature, phase: 'pending', attempts: 0, due: Date.now(), inFlight: false, subagents: new Set() })
      changed = true
    }
    if (changed) this.onChange()
    this.pump()
  }

  get snapshot(): { subagents: ReadonlySet<string>; unresolved: ReadonlySet<string>; failedParents: readonly string[] } {
    const subagents = new Set<string>(), unresolved = new Set<string>(), failedParents: string[] = []
    for (const [parent, state] of this.parents) {
      if (state.phase === 'resolved') for (const id of state.subagents) subagents.add(id)
      else for (const id of state.children) unresolved.add(id)
      if (state.phase === 'failed') failedParents.push(parent)
    }
    return { subagents, unresolved, failedParents }
  }

  reset(): void {
    ++this.epoch
    this.parents.clear()
    clearTimeout(this.timer)
    this.timer = undefined
  }

  dispose(): void { this.disposed = true; this.reset() }

  private pump(): void {
    if (this.disposed) return
    clearTimeout(this.timer)
    this.timer = undefined
    for (const [parent, state] of this.parents) {
      if (this.inFlight >= 4) break
      if (state.inFlight || !['pending', 'retrying'].includes(state.phase) || state.due > Date.now()) continue
      state.inFlight = true
      state.attempts++
      this.inFlight++
      const epoch = this.epoch
      const current = () => !this.disposed && epoch === this.epoch && this.parents.get(parent) === state
      void Promise.resolve().then(() => current() ? this.query(parent) : undefined).then((result) => {
        if (!current() || !result) return
        if (result.error) throw new Error(result.error)
        if (result.parentSessionId !== parent || !Array.isArray(result.children)) throw new Error('Invalid subagent classification response')
        // The Host maps startedAt specifically from subAgentStartedAt, not fork creation time.
        state.subagents = new Set(result.children.filter((child) => (child.parentCallId || child.startedAt) && state.children.includes(child.childSessionId)).map((child) => child.childSessionId))
        state.phase = 'resolved'
        this.onChange()
      }).catch((reason: unknown) => {
        if (!current()) return
        state.phase = state.attempts < 3 ? 'retrying' : 'failed'
        state.due = Date.now() + 500 * 2 ** (state.attempts - 1)
        this.onError(new Error(`Subagent classification unavailable: ${reason instanceof Error ? reason.message : String(reason)}`))
        this.onChange()
      }).finally(() => {
        state.inFlight = false
        this.inFlight--
        this.pump()
      })
    }
    const due = [...this.parents.values()].filter((state) => !state.inFlight && state.phase === 'retrying' && state.due > Date.now()).map((state) => state.due)
    if (due.length) this.timer = setTimeout(() => this.pump(), Math.max(0, Math.min(...due) - Date.now()))
  }
}
