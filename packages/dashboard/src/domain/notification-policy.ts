import type { SessionSummary } from '@agent-kernel/shared'
import { deriveSessionState } from '@agent-kernel/shared'

export type SessionNotificationEventKind =
  | 'summary_status_changed'
  | 'user_message_sent'
  | 'approval_requested'
  | 'session_error'

export type NotificationDecision = {
  notify: boolean
  level: 'none' | 'badge' | 'toast' | 'system'
  reason:
    | 'focused_session'
    | 'user_initiated'
    | 'background_session_completed'
    | 'approval_required'
    | 'error'
    | 'no_material_change'
    | 'not_previously_running'
    | 'still_running'
}

export function decideInactiveSummaryNotification(input: {
  previousStatus: SessionSummary['status'] | undefined
  nextStatus: SessionSummary['status'] | undefined
  focusedSessionId: string | null
  eventSessionId: string
  eventKind?: SessionNotificationEventKind
}): NotificationDecision {
  if (input.eventSessionId === input.focusedSessionId) return no('focused_session')
  if (input.eventKind === 'user_message_sent') return no('user_initiated')
  if (input.previousStatus === input.nextStatus) return no('no_material_change')

  const previous = deriveSessionState({ status: input.previousStatus })
  const next = deriveSessionState({ status: input.nextStatus })
  if (!previous.isRunning) return no('not_previously_running')
  if (next.isRunning) return no('still_running')
  if (next.isWaitingForUser) return { notify: true, level: 'toast', reason: 'approval_required' }
  if (next.activity === 'failed') return { notify: true, level: 'toast', reason: 'error' }
  if (next.activity === 'idle' || next.activity === 'done') return { notify: true, level: 'toast', reason: 'background_session_completed' }
  return no('no_material_change')
}

function no(reason: NotificationDecision['reason']): NotificationDecision {
  return { notify: false, level: 'none', reason }
}
