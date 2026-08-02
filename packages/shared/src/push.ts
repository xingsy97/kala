/**
 * Web Push wire types.
 *
 * Kept in shared so the dashboard, host, and any future push-consuming
 * tools import a single definition. This module deliberately covers only
 * the wire contract — VAPID key encoding, subscription payloads, and the
 * push message envelope — not the server dispatcher (host/push/dispatch)
 * or the browser subscription flow (dashboard/lib/push).
 *
 * Notification kinds mirror DesktopNotificationKind in
 * dashboard/src/lib/desktop-notifications.ts so the same preferences UI
 * governs both foreground (Notification API) and background (Web Push)
 * delivery.
 */

export type DesktopNotificationKind =
  | 'approval_required'
  | 'waiting_for_user'
  | 'session_error'
  | 'connection_lost'
  | 'workspace_offline'

export const DESKTOP_NOTIFICATION_KINDS: readonly DesktopNotificationKind[] = [
  'approval_required',
  'waiting_for_user',
  'session_error',
  'connection_lost',
  'workspace_offline',
]

/**
 * The Push subscription payload as returned by pushManager.subscribe().toJSON()
 * plus the client-side preferences snapshot at subscription time.
 *
 * Servers SHOULD treat `kinds` as the source of truth for whether to send a
 * given event to a subscriber — the browser has no other channel to tell the
 * server which categories it wants after the initial subscription.
 */
export type PushSubscribeRequest = {
  endpoint: string
  keys: { p256dh: string; auth: string }
  deviceId?: string
  deviceName?: string
  ownerId?: string
  userAgent?: string
  kinds: readonly DesktopNotificationKind[]
}

/**
 * Response for GET /push/vapid-public-key. `null` means push is not
 * configured on this host (env vars missing) — dashboard should hide the
 * push UI in that case instead of failing on subscribe.
 */
export type PushDevice = {
  deviceId: string
  name: string
  enabled: boolean
  current: boolean
  lastSeenAt: string
  userAgent?: string
}

export type PushVapidKeyResponse = {
  publicKey: string | null
}

/**
 * Server → SW push envelope. Deliberately narrow: only enough to render a
 * notification and route the click. Sensitive detail (diff, message body,
 * secrets) MUST NOT ride in the envelope; the SW can only ever display what
 * lands here, and once shown the user can quote it into any UI.
 */
export type PushEventPayload = {
  kind: DesktopNotificationKind
  sessionId?: string
  title: string
  body: string
  /** Deep-link target for notificationclick. Same origin as the app. */
  url: string
  /** Notification-tag for coalescing repeated events of the same kind. */
  tag?: string
  /** Optional icon override; otherwise the SW picks a default. */
  icon?: string
}
