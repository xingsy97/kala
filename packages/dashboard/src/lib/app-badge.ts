import type { SessionSummary } from '@agent-kernel/shared'

export type AppBadgeInput = {
  sessions: readonly SessionSummary[]
  activePendingApprovals: number
  activeSessionHasError: boolean
  disconnected: boolean
}

export function deriveAppBadgeCount(input: AppBadgeInput): number {
  const waiting = input.sessions.filter((session) => session.status === 'awaiting_approval').length
  const failed = input.sessions.filter((session) => session.status === 'error').length
  return Math.max(waiting, input.activePendingApprovals)
    + Math.max(failed, input.activeSessionHasError ? 1 : 0)
    + (input.disconnected ? 1 : 0)
}

export function appBadgeSupported(navigatorValue: Navigator = navigator): boolean {
  return typeof navigatorValue.setAppBadge === 'function' && typeof navigatorValue.clearAppBadge === 'function'
}

export async function updateAppBadge(count: number, navigatorValue: Navigator = navigator): Promise<void> {
  if (!appBadgeSupported(navigatorValue)) return
  try {
    if (count > 0) await navigatorValue.setAppBadge(count)
    else await navigatorValue.clearAppBadge()
  } catch {}
}
