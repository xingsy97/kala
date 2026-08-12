import { describe, expect, it, vi } from 'vitest'
import { DashboardConnectionManager } from './dashboard-connection-manager.js'

class SocketMock {
  connected = true
  handlers = new Map<string, Array<(...args: any[]) => void>>()
  emits: Array<{ event: string; payload: any }> = []
  on(event: string, handler: (...args: any[]) => void): this { this.handlers.set(event, [...this.handlers.get(event) ?? [], handler]); return this }
  emit(event: string, payload: any, ack?: (value: any) => void): this {
    this.emits.push({ event, payload })
    if (event.includes('subscribe')) queueMicrotask(() => ack?.({ requestId: payload.requestId, generation: payload.generation, accepted: payload.channels, rejected: [], cursors: {} }))
    return this
  }
  fire(event: string): void { for (const handler of this.handlers.get(event) ?? []) handler() }
}

describe('DashboardConnectionManager', () => {
  it('reference-counts channels and restores them in one batch', async () => {
    const socket = new SocketMock()
    const manager = new DashboardConnectionManager(socket as never)
    const release1 = manager.acquire('session:s1')
    const release2 = manager.acquire('session:s1')
    await vi.waitFor(() => expect(manager.snapshot().get('session:s1')?.state).toBe('active'))
    expect(socket.emits.filter((entry) => entry.event === 'client:subscribe_channels')).toHaveLength(1)
    release1()
    expect(socket.emits.filter((entry) => entry.event === 'client:unsubscribe_channels')).toHaveLength(0)
    socket.connected = false; socket.fire('disconnect')
    manager.acquire('workspace:w1')
    socket.connected = true; socket.fire('connect')
    await vi.waitFor(() => expect(socket.emits.some((entry) => entry.event === 'client:restore_subscriptions' && entry.payload.channels.length === 2)).toBe(true))
    release2()
  })

  it('switches Sessions on the same physical socket and restores only active channels', async () => {
    const socket = new SocketMock()
    const manager = new DashboardConnectionManager(socket as never)
    const releaseWorkspace = manager.acquire('workspace:w1')
    const releaseFirst = manager.acquire('session:s1', 4)
    await vi.waitFor(() => expect(manager.snapshot().get('session:s1')?.state).toBe('active'))

    const releaseSecond = manager.acquire('session:s2', 8)
    releaseFirst()
    await vi.waitFor(() => expect(manager.snapshot().get('session:s2')?.state).toBe('active'))
    expect(manager.socket).toBe(socket)
    expect(socket.emits.filter((entry) => entry.event === 'client:unsubscribe_channels').at(-1)?.payload.channels).toEqual(['session:s1'])

    socket.connected = false; socket.fire('disconnect')
    socket.connected = true; socket.fire('connect')
    await vi.waitFor(() => expect(socket.emits.some((entry) => entry.event === 'client:restore_subscriptions'
      && entry.payload.channels.includes('workspace:w1')
      && entry.payload.channels.includes('session:s2')
      && !entry.payload.channels.includes('session:s1')
      && entry.payload.cursors['session:s2'] === 8)).toBe(true))
    releaseSecond(); releaseWorkspace()
  })

  it('ignores stale acknowledgements after a channel is released', async () => {
    const socket = new SocketMock()
    let captured: ((value: any) => void) | undefined
    socket.emit = function (event: string, payload: any, ack?: (value: any) => void) { this.emits.push({ event, payload }); captured = ack; return this }
    const manager = new DashboardConnectionManager(socket as never)
    const release = manager.acquire('session:s1')
    release()
    captured?.({ requestId: 'old', generation: 1, accepted: ['session:s1'], rejected: [], cursors: {} })
    expect(manager.snapshot().has('session:s1')).toBe(false)
  })
})
