import type { ChannelSubscriptionResult, DashboardChannel, DashboardClientToServerEvents, DashboardServerToClientEvents } from '@agent-kernel/shared'
import type { Socket } from 'socket.io-client'

export type ManagedDashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
export type ChannelWireState = 'desired' | 'subscribing' | 'active' | 'rejected'
type ChannelRecord = { refs: number; generation: number; cursor?: number; state: ChannelWireState; error?: string; errorListeners: Set<(code: string) => void> }
type AcquireOptions = { freshBaseline?: boolean; onError?(code: string): void }

export class DashboardConnectionManager {
  private readonly channels = new Map<DashboardChannel, ChannelRecord>()
  private request = 0
  constructor(readonly socket: ManagedDashboardSocket) {
    socket.on('connect', () => { void this.restore() })
    socket.on('disconnect', () => {
      for (const record of this.channels.values()) if (record.refs > 0) record.state = 'desired'
    })
  }

  acquire(channel: DashboardChannel, cursor?: number, options: AcquireOptions = {}): () => void {
    const current = this.channels.get(channel)
    if (current) {
      current.refs += 1
      if (cursor !== undefined) current.cursor = Math.max(current.cursor ?? 0, cursor)
      if (options.onError) current.errorListeners.add(options.onError)
      // A room can outlive its UI consumer (hover preview, child card). A new
      // selection needs a baseline delivered after its listeners were bound.
      if (this.socket.connected && (options.freshBaseline || current.state === 'desired')) void this.subscribe([channel], false)
    } else {
      this.channels.set(channel, { refs: 1, generation: 0, ...(cursor !== undefined ? { cursor } : {}), state: 'desired', errorListeners: new Set(options.onError ? [options.onError] : []) })
      if (this.socket.connected) void this.subscribe([channel], false)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const record = this.channels.get(channel)
      if (options.onError) record?.errorListeners.delete(options.onError)
      if (!record || --record.refs > 0) return
      this.channels.delete(channel)
      if (this.socket.connected) this.unsubscribe([channel])
    }
  }

  async waitUntilActive(channel: DashboardChannel, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = this.channels.get(channel)?.state
      if (state === 'active') return true
      if (state === 'rejected' || state === undefined) return false
      await new Promise((resolve) => window.setTimeout(resolve, 10))
    }
    return this.channels.get(channel)?.state === 'active'
  }

  setCursor(channel: DashboardChannel, cursor: number): void {
    const record = this.channels.get(channel)
    if (record) record.cursor = Math.max(record.cursor ?? 0, cursor)
  }

  snapshot(): ReadonlyMap<DashboardChannel, Readonly<ChannelRecord>> { return new Map(this.channels) }

  refresh(channel: DashboardChannel): void {
    if (!this.channels.has(channel)) return
    if (this.socket.connected) void this.subscribe([channel], false)
    else this.socket.connect()
  }

  async restore(): Promise<void> {
    const desired = [...this.channels.entries()].filter(([, record]) => record.refs > 0).map(([channel]) => channel)
    if (desired.length) await this.subscribe(desired, true)
  }

  private async subscribe(channels: DashboardChannel[], restore: boolean): Promise<void> {
    const generation = ++this.request
    for (const channel of channels) {
      const record = this.channels.get(channel)
      if (record) { record.generation = generation; record.state = 'subscribing'; delete record.error }
    }
    const cursors = Object.fromEntries(channels.flatMap((channel) => { const cursor = this.channels.get(channel)?.cursor; return cursor === undefined ? [] : [[channel, cursor]] }))
    const event = restore ? 'client:restore_subscriptions' : 'client:subscribe_channels'
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        for (const channel of channels) {
          const record = this.channels.get(channel)
          if (record?.generation !== generation) continue
          record.state = 'desired'
          record.error = 'subscription_timeout'
          for (const listener of record.errorListeners) listener(record.error)
        }
        resolve()
      }, 5_000)
      this.socket.emit(event, { requestId: `channels-${generation}`, generation, channels, ...(Object.keys(cursors).length ? { cursors } : {}) }, (result: ChannelSubscriptionResult) => {
        window.clearTimeout(timer)
        this.applyAck(result)
        resolve()
      })
    })
  }

  private applyAck(result: ChannelSubscriptionResult): void {
    for (const channel of result.accepted) {
      const record = this.channels.get(channel)
      if (!record || record.generation !== result.generation || record.refs === 0) continue
      record.state = 'active'
      const cursor = result.cursors[channel]
      if (cursor !== undefined) record.cursor = Math.max(record.cursor ?? 0, cursor)
    }
    for (const rejection of result.rejected) {
      const record = this.channels.get(rejection.channel)
      if (!record || record.generation !== result.generation) continue
      record.state = 'rejected'; record.error = rejection.code
      for (const listener of record.errorListeners) listener(rejection.code)
    }
  }

  private unsubscribe(channels: DashboardChannel[]): void {
    const generation = ++this.request
    this.socket.emit('client:unsubscribe_channels', { requestId: `unsubscribe-${generation}`, generation, channels }, () => {})
  }
}
