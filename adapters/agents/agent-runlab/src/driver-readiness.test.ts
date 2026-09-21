import type { DashboardClientToServerEvents, DashboardServerToClientEvents } from '@agent-kernel/shared'
import type { Socket } from 'socket.io-client'
import { describe, expect, it, vi } from 'vitest'

import { waitForExecutor } from './driver-readiness.js'

type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

describe('Kala driver readiness', () => {
  it('polls again when the first executor snapshot is empty', async () => {
    vi.useFakeTimers()
    let listener: DashboardServerToClientEvents['server:executors'] | undefined
    let requests = 0
    const socket = {
      on: vi.fn((_event, value) => { listener = value; return socket }),
      off: vi.fn(() => socket),
      emit: vi.fn(() => {
        requests += 1
        listener?.({ executors: requests === 1 ? [] : [{ workspaceId: 'workspace-one' }] } as Parameters<DashboardServerToClientEvents['server:executors']>[0])
        return socket
      }),
    } as unknown as DashboardSocket

    const ready = waitForExecutor(socket, 'workspace-one', 1_000, 10)
    await vi.advanceTimersByTimeAsync(10)

    await expect(ready).resolves.toBeUndefined()
    expect(requests).toBe(2)
    expect(socket.off).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
