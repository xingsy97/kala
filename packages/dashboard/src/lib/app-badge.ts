import type { SessionSummary } from '@agent-kernel/shared'

export type AppBadgeInput = {
  sessions: readonly SessionSummary[]
  activePendingApprovals: number
  activeSessionHasError: boolean
  disconnected: boolean
}

export function deriveAppBadgeCount(input: AppBadgeInput): number {
  // A child session is surfaced through its parent agent tool card. Counting it
  // independently creates duplicate app-level attention for one parent turn.
  const topLevelSessions = input.sessions.filter((session) => !session.parentSessionId)
  const waiting = topLevelSessions.filter((session) => session.status === 'awaiting_approval').length
  const failed = topLevelSessions.filter((session) => session.status === 'error').length
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

/**
 * Dismiss notification-center entries owned by this app. iOS derives the Home
 * Screen badge from delivered Web Push notifications as well as the Badging
 * API, so clearAppBadge alone is insufficient after the app is opened.
 */
export async function dismissAppNotifications(
  serviceWorker: ServiceWorkerContainer | undefined = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
): Promise<void> {
  if (!serviceWorker) return
  try {
    const registration = await serviceWorker.getRegistration()
    if (!registration || typeof registration.getNotifications !== 'function') return
    const notifications = await registration.getNotifications()
    notifications.forEach((notification) => notification.close())
  } catch {}
}

/** Clear both browser badge sources when the user returns to the app. */
export async function clearAppNotificationIndicators(
  navigatorValue: Navigator = navigator,
): Promise<void> {
  await Promise.all([
    updateAppBadge(0, navigatorValue),
    dismissAppNotifications(navigatorValue.serviceWorker),
  ])
}
