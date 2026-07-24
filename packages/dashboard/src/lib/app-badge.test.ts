import { describe, expect, it, vi } from 'vitest'

import { deriveAppBadgeCount, updateAppBadge } from './app-badge.js'

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
})
