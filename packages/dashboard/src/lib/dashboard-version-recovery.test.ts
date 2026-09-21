import { describe, expect, it, vi } from 'vitest'

import { loadDashboardExport, recoverStaleDashboard, StaleDashboardAssetError } from './dashboard-version-recovery.js'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}

describe('Dashboard version recovery', () => {
  it('validates lazy module exports before React receives the component', async () => {
    const component = (): null => null
    await expect(loadDashboardExport(Promise.resolve({ Example: component }), 'Example', 'example')).resolves.toEqual({ default: component })
    await expect(loadDashboardExport(Promise.resolve({ Example: undefined }), 'Example', 'example')).rejects.toBeInstanceOf(StaleDashboardAssetError)
  })

  it('reloads once per boot generation and does not loop', async () => {
    const storage = memoryStorage(); const reload = vi.fn()
    const error = new StaleDashboardAssetError('feature', 'Feature')
    await expect(recoverStaleDashboard(error, { identity: { generation: 7, releaseId: 'r1' }, fetchStatus: async () => ({ generation: 8, releaseId: 'r2' }), storage, reload })).resolves.toBe('reloading')
    await expect(recoverStaleDashboard(error, { identity: { generation: 7, releaseId: 'r1' }, fetchStatus: async () => ({ generation: 8, releaseId: 'r2' }), storage, reload })).resolves.toBe('already-attempted')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('activates a waiting service worker before reloading', async () => {
    const reload = vi.fn(); const postMessage = vi.fn(); let controllerChange: EventListener | undefined
    const serviceWorker = {
      getRegistration: async () => ({ update: async () => {}, waiting: { postMessage } }),
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { controllerChange = listener as EventListener; queueMicrotask(() => controllerChange?.(new Event('controllerchange'))) },
      removeEventListener: vi.fn(),
    } as unknown as ServiceWorkerContainer
    await expect(recoverStaleDashboard(new StaleDashboardAssetError('feature'), { identity: { generation: 3 }, fetchStatus: async () => ({ generation: 4 }), storage: memoryStorage(), serviceWorker, reload })).resolves.toBe('reloading')
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }); expect(reload).toHaveBeenCalledTimes(1)
  })

  it('recovers ordinary render failures only when the served dashboard version changed', async () => {
    const storage = memoryStorage(); const reload = vi.fn()
    const error = new Error('Rendered more hooks than during the previous render')
    await expect(recoverStaleDashboard(error, { recoverWhenVersionChanged: true, identity: { generation: 9, releaseId: 'old' }, fetchStatus: async () => ({ generation: 10, releaseId: 'new' }), storage, reload })).resolves.toBe('reloading')
    await expect(recoverStaleDashboard(error, { recoverWhenVersionChanged: true, identity: { generation: 9, releaseId: 'old' }, fetchStatus: async () => ({ generation: 10, releaseId: 'new' }), storage, reload })).resolves.toBe('already-attempted')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload ordinary render failures when the dashboard version is current', async () => {
    const reload = vi.fn()
    await expect(recoverStaleDashboard(new Error('render failed'), { recoverWhenVersionChanged: true, identity: { generation: 12, releaseId: 'same' }, fetchStatus: async () => ({ generation: 12, releaseId: 'same' }), storage: memoryStorage(), reload })).resolves.toBe('not-stale')
    expect(reload).not.toHaveBeenCalled()
  })
})
