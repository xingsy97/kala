import { describe, expect, it, vi } from 'vitest'

import { activatePwaUpdate, initPwa, isStandalone } from './pwa.js'

function serviceWorkerHarness(): {
  serviceWorker: Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'>
  dispatchControllerChange(): void
  add: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  let controllerChange: EventListener | null = null
  const add = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'controllerchange') controllerChange = listener as EventListener
  })
  const remove = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'controllerchange' && controllerChange === listener) controllerChange = null
  })
  return {
    serviceWorker: { addEventListener: add, removeEventListener: remove } as unknown as Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'>,
    dispatchControllerChange: () => controllerChange?.(new Event('controllerchange')),
    add,
    remove,
  }
}

describe('PWA standalone detection', () => {
  it('does not register or check service workers in the desktop webview', async () => {
    Object.defineProperty(window, '__RUNLAB_DESKTOP__', { value: true, configurable: true })
    try {
      const handlers = { onNeedRefresh: vi.fn(), onOfflineReady: vi.fn(), onRegistered: vi.fn() }
      const controller = initPwa(handlers)
      await controller.checkForUpdate()
      await controller.applyUpdate()
      expect(handlers.onRegistered).not.toHaveBeenCalled()
    } finally {
      delete (window as Window & { __RUNLAB_DESKTOP__?: boolean }).__RUNLAB_DESKTOP__
    }
  })
  it('enables PWA-only behavior for standard and legacy iOS standalone modes', () => {
    expect(isStandalone({ matches: true })).toBe(true)
    expect(isStandalone({ navigatorStandalone: true })).toBe(true)
    expect(isStandalone({ matches: false, navigatorStandalone: false })).toBe(false)
  })
})

describe('activatePwaUpdate', () => {
  it('reloads immediately after the new worker takes control', async () => {
    const harness = serviceWorkerHarness()
    const reload = vi.fn()
    const sendSkipWaiting = vi.fn(async () => {})

    const applying = activatePwaUpdate({
      sendSkipWaiting,
      serviceWorker: harness.serviceWorker,
      reload,
      timeoutMs: 10_000,
    })
    await Promise.resolve()
    expect(sendSkipWaiting).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()

    harness.dispatchControllerChange()
    await applying

    expect(reload).toHaveBeenCalledTimes(1)
    expect(harness.remove).toHaveBeenCalledTimes(1)
  })

  it('falls back to a bounded reload when controllerchange never arrives', async () => {
    vi.useFakeTimers()
    try {
      const harness = serviceWorkerHarness()
      const reload = vi.fn()
      const applying = activatePwaUpdate({
        sendSkipWaiting: async () => {},
        serviceWorker: harness.serviceWorker,
        reload,
        timeoutMs: 100,
      })
      await vi.advanceTimersByTimeAsync(99)
      expect(reload).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await applying

      expect(reload).toHaveBeenCalledTimes(1)
      expect(harness.remove).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reload when sending SKIP_WAITING fails', async () => {
    const harness = serviceWorkerHarness()
    const reload = vi.fn()

    await expect(activatePwaUpdate({
      sendSkipWaiting: async () => { throw new Error('message failed') },
      serviceWorker: harness.serviceWorker,
      reload,
      timeoutMs: 100,
    })).rejects.toThrow('message failed')

    expect(reload).not.toHaveBeenCalled()
    expect(harness.remove).toHaveBeenCalledTimes(1)
  })
})
