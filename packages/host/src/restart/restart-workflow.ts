import type { HostRestartAttempt } from '@agent-kernel/shared'

export type RestartWorkflowState = {
  readonly current: HostRestartAttempt | null
  readonly last: HostRestartAttempt | null
}

type AttemptEventFields = {
  readonly attemptId: string
  readonly updatedAt: string
  readonly sessions: HostRestartAttempt['sessions']
}

export type RestartWorkflowEvent =
  | { readonly kind: 'request'; readonly attempt: HostRestartAttempt }
  | ({ readonly kind: 'drain_started' } & AttemptEventFields)
  | ({ readonly kind: 'checkpoints_reached' } & AttemptEventFields)
  | ({ readonly kind: 'restart_started' } & AttemptEventFields)
  | ({ readonly kind: 'abort'; readonly error: string } & AttemptEventFields)
  | ({ readonly kind: 'fail'; readonly error: string } & AttemptEventFields)

export type RestartWorkflowCommand =
  | { readonly kind: 'publish'; readonly attempt: HostRestartAttempt }
  | { readonly kind: 'begin_drain'; readonly attemptId: string; readonly mode: HostRestartAttempt['mode']; readonly timeoutMs?: number }
  | { readonly kind: 'wait_for_checkpoints'; readonly attemptId: string; readonly sessionIds: readonly string[] }
  | { readonly kind: 'schedule_timeout'; readonly attemptId: string; readonly timeoutMs: number }
  | { readonly kind: 'clear_timeout'; readonly attemptId: string }
  | { readonly kind: 'end_drain'; readonly attemptId: string }
  | { readonly kind: 'start_restart'; readonly attemptId: string }
  | { readonly kind: 'close_and_spawn'; readonly attemptId: string }

export type RestartWorkflowTransition = {
  readonly state: RestartWorkflowState
  readonly commands: readonly RestartWorkflowCommand[]
}

export function transitionRestartWorkflow(
  state: RestartWorkflowState,
  event: RestartWorkflowEvent,
): RestartWorkflowTransition {
  if (event.kind === 'request') {
    if (state.current && !isTerminalRestartPhase(state.current.phase)) return unchanged(state)
    return {
      state: { ...state, current: event.attempt },
      commands: [
        { kind: 'publish', attempt: event.attempt },
        event.attempt.mode === 'force'
          ? { kind: 'start_restart', attemptId: event.attempt.attemptId }
          : {
              kind: 'begin_drain',
              attemptId: event.attempt.attemptId,
              mode: event.attempt.mode,
              ...(event.attempt.timeoutMs !== undefined ? { timeoutMs: event.attempt.timeoutMs } : {}),
            },
      ],
    }
  }

  const current = state.current
  if (!current || current.attemptId !== event.attemptId) return unchanged(state)

  if (event.kind === 'drain_started') {
    if (current.phase !== 'requested') return unchanged(state)
    const attempt = updateAttempt(current, event, 'draining')
    const commands: RestartWorkflowCommand[] = [
      { kind: 'publish', attempt },
      { kind: 'wait_for_checkpoints', attemptId: current.attemptId, sessionIds: attempt.sessions.map((session) => session.sessionId) },
    ]
    if (current.timeoutMs !== undefined && current.timeoutMs > 0) {
      commands.push({ kind: 'schedule_timeout', attemptId: current.attemptId, timeoutMs: current.timeoutMs })
    }
    return { state: { ...state, current: attempt }, commands }
  }

  if (event.kind === 'checkpoints_reached') {
    if (current.phase !== 'draining') return unchanged(state)
    const attempt = updateAttempt(current, event, 'checkpoint_reached')
    return {
      state: { ...state, current: attempt },
      commands: [
        { kind: 'clear_timeout', attemptId: current.attemptId },
        { kind: 'publish', attempt },
        { kind: 'start_restart', attemptId: current.attemptId },
      ],
    }
  }

  if (event.kind === 'restart_started') {
    if (current.phase !== 'requested' && current.phase !== 'checkpoint_reached') return unchanged(state)
    const attempt = updateAttempt(current, event, 'restarting')
    return {
      state: { ...state, current: attempt },
      commands: [
        { kind: 'clear_timeout', attemptId: current.attemptId },
        { kind: 'publish', attempt },
        { kind: 'close_and_spawn', attemptId: current.attemptId },
      ],
    }
  }

  if (event.kind === 'abort' || event.kind === 'fail') {
    if (isTerminalRestartPhase(current.phase)) return unchanged(state)
    const attempt: HostRestartAttempt = {
      ...updateAttempt(current, event, event.kind === 'abort' ? 'aborted' : 'failed'),
      error: event.error,
    }
    return {
      state: { current: null, last: attempt },
      commands: [
        { kind: 'clear_timeout', attemptId: current.attemptId },
        { kind: 'end_drain', attemptId: current.attemptId },
        { kind: 'publish', attempt },
      ],
    }
  }

  return unchanged(state)
}

export function isTerminalRestartPhase(phase: HostRestartAttempt['phase']): boolean {
  return phase === 'completed' || phase === 'aborted' || phase === 'failed'
}

function updateAttempt(
  current: HostRestartAttempt,
  event: AttemptEventFields,
  phase: HostRestartAttempt['phase'],
): HostRestartAttempt {
  const { error: _error, ...withoutError } = current
  return {
    ...withoutError,
    phase,
    updatedAt: event.updatedAt,
    sessions: event.sessions,
  }
}

function unchanged(state: RestartWorkflowState): RestartWorkflowTransition {
  return { state, commands: [] }
}
