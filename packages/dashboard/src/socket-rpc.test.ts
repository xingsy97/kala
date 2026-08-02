import { describe, expect, it, vi } from 'vitest'

import { emitRpc } from './socket-rpc.js'

describe('emitRpc', () => {
  it('reuses one operation id across timeout retries', async () => {
    const emitWithAck = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ ok: true, value: 'done' })
    const socket = {
      connected: true,
      active: true,
      timeout: vi.fn(() => ({ emitWithAck })),
      connect: vi.fn(),
    }

    await expect(emitRpc<string>(socket as never, 'client:test', { value: 1 }, {
      attempts: 2,
      operationId: 'stable-op',
    })).resolves.toBe('done')

    expect(emitWithAck).toHaveBeenCalledTimes(2)
    expect(emitWithAck.mock.calls[0]?.[1].operationId).toBe('stable-op')
    expect(emitWithAck.mock.calls[1]?.[1].operationId).toBe('stable-op')
  })

  it('throws business errors from ACK envelopes', async () => {
    const socket = {
      connected: true,
      active: true,
      timeout: () => ({ emitWithAck: async () => ({ ok: false, error: 'denied' }) }),
      connect: vi.fn(),
    }
    await expect(emitRpc(socket as never, 'client:test', {}, { attempts: 1 })).rejects.toThrow('denied')
  })
})
