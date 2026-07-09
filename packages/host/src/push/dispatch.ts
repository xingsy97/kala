/**
 * Push dispatch loop.
 *
 * Wraps web-push.sendNotification with subscription-store bookkeeping:
 *
 * - Filters recipients by their per-kind preferences (a subscriber that
 *   didn't opt in to `approval_required` never receives one).
 * - Fans out in parallel with individual error handling — one bad endpoint
 *   never blocks the rest.
 * - 404 / 410 responses mean the subscription is dead at the browser and
 *   the store drops it. Other errors are logged but keep the subscription
 *   (transient outages of push services should not garbage-collect valid
 *   subscribers).
 *
 * The payload contract is intentionally narrow (see PushEventPayload in
 * shared/src/push.ts): title/body/url/tag only, never diff content or
 * secrets.
 */

import webpush from 'web-push'

import type { PushEventPayload, DesktopNotificationKind } from '@agent-kernel/shared/push'

import type { PushSubscriptionStore } from './store.js'
import type { VapidKeys } from './vapid.js'

export type PushDispatcher = {
  /**
   * Send a notification to every subscriber whose preferences include
   * `payload.kind`. Returns the count of subscribers actually messaged.
   */
  send: (payload: PushEventPayload) => Promise<number>
  /** Diagnostic surface for the settings page. */
  status: () => { configured: true; subscribers: number } | { configured: false }
}

export function createPushDispatcher(input: {
  store: PushSubscriptionStore
  vapid: VapidKeys | null
  logger?: (message: string, meta?: Record<string, unknown>) => void
}): PushDispatcher {
  const { store, vapid } = input
  const log = input.logger ?? ((message, meta) => {
    if (meta) {
      // eslint-disable-next-line no-console
      console.warn(`[push] ${message}`, meta)
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[push] ${message}`)
    }
  })

  if (vapid) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
  }

  return {
    status: () => vapid ? { configured: true, subscribers: store.size() } : { configured: false },
    send: async (payload: PushEventPayload): Promise<number> => {
      if (!vapid) return 0
      const targets = store.list().filter((sub) => matchesKind(sub.kinds, payload.kind))
      if (targets.length === 0) return 0
      const body = JSON.stringify(payload)
      const outcomes = await Promise.allSettled(
        targets.map((subscription) =>
          webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
            },
            body,
            { TTL: 60 * 60 * 24 }, // one day; after that, the event is stale
          ),
        ),
      )
      let delivered = 0
      outcomes.forEach((outcome, index) => {
        const subscription = targets[index]!
        if (outcome.status === 'fulfilled') {
          delivered += 1
          return
        }
        const err = outcome.reason as (Error & { statusCode?: number }) | undefined
        const status = err?.statusCode
        if (status === 404 || status === 410) {
          store.remove(subscription.endpoint)
          log('dropped dead subscription', { endpoint: subscription.endpoint, statusCode: status })
          return
        }
        log('push send failed', {
          endpoint: subscription.endpoint,
          statusCode: status,
          message: err?.message,
        })
      })
      return delivered
    },
  }
}

function matchesKind(subscribed: readonly DesktopNotificationKind[], kind: DesktopNotificationKind): boolean {
  if (subscribed.length === 0) return false
  return subscribed.includes(kind)
}
