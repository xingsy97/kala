import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAuthenticatedPwaState } from './auth-session.js'

describe('clearAuthenticatedPwaState', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('clears badge, tells the worker to close notifications, and removes app caches', async () => {
    const postMessage = vi.fn(), clearAppBadge = vi.fn().mockResolvedValue(undefined), deleteCache = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('navigator', { clearAppBadge, serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ active: { postMessage } }) } })
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['ak-icons-v1', 'workbox-precache']), delete: deleteCache })
    await clearAuthenticatedPwaState()
    expect(clearAppBadge).toHaveBeenCalledOnce()
    expect(postMessage).toHaveBeenCalledWith({ type: 'AUTH_LOGOUT' })
    expect(deleteCache).toHaveBeenCalledWith('ak-icons-v1')
    expect(deleteCache).not.toHaveBeenCalledWith('workbox-precache')
  })
})
