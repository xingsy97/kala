import { describe, expect, it, vi } from 'vitest'

import { clearAppNotificationIndicators, deriveAppBadgeCount, dismissAppNotifications, updateAppBadge } from './app-badge.js'

describe('app badge', () => {
  it('counts actionable state without counting running sessions', () => {
    expect(deriveAppBadgeCount({
      sessions: [
        { sessionId: 'a', createdAt: '', eventCount: 1, status: 'thinking' },
        { sessionId: 'b', createdAt: '', eventCount: 1, status: 'awaiting_approval' },
        { sessionId: 'c', createdAt: '', eventCount: 1, status: 'error' },
      ],
      activePendingApprovals: 1,
      activeSessionHasError: true,
      disconnected: true,
    })).toBe(3)
  })

  it('excludes sub-agent sessions from application badge attention', () => {
    expect(deriveAppBadgeCount({
      sessions: [
        { sessionId: 'child-a', parentSessionId: 'parent', createdAt: '', eventCount: 1, status: 'awaiting_approval' },
        { sessionId: 'child-b', parentSessionId: 'parent', createdAt: '', eventCount: 1, status: 'error' },
      ],
      activePendingApprovals: 0,
      activeSessionHasError: false,
      disconnected: false,
    })).toBe(0)
  })

  it('updates supported navigator badges and ignores unsupported browsers', async () => {
    const setAppBadge = vi.fn(async () => {})
    const clearAppBadge = vi.fn(async () => {})
    const supported = { setAppBadge, clearAppBadge } as unknown as Navigator
    await updateAppBadge(2, supported)
    await updateAppBadge(0, supported)
    await updateAppBadge(2, {} as Navigator)
    expect(setAppBadge).toHaveBeenCalledWith(2)
    expect(clearAppBadge).toHaveBeenCalledOnce()
  })

  it('dismisses all delivered push notifications on app entry', async () => {
    const notifications = [{ close: vi.fn() }, { close: vi.fn() }]
    const getNotifications = vi.fn(async () => notifications)
    const serviceWorker = {
      getRegistration: vi.fn(async () => ({ getNotifications })),
    } as unknown as ServiceWorkerContainer

    await dismissAppNotifications(serviceWorker)

    expect(getNotifications).toHaveBeenCalledOnce()
    expect(notifications.every((notification) => notification.close.mock.calls.length === 1)).toBe(true)
  })

  it('clears both Badging API state and delivered notifications', async () => {
    const clearAppBadge = vi.fn(async () => {})
    const notification = { close: vi.fn() }
    const navigatorValue = {
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge,
      serviceWorker: {
        getRegistration: vi.fn(async () => ({ getNotifications: async () => [notification] })),
      },
    } as unknown as Navigator

    await clearAppNotificationIndicators(navigatorValue)

    expect(clearAppBadge).toHaveBeenCalledOnce()
    expect(notification.close).toHaveBeenCalledOnce()
  })
})
