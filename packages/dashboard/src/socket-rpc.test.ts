import { describe, expect, it, vi } from 'vitest'

import { cancelSession } from './session.js'
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

  it('waits for cancel acknowledgement and surfaces Host failure', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: false, error: 'cancel denied' })
    const socket = {
      connected: true,
      active: true,
      timeout: () => ({ emitWithAck }),
      connect: vi.fn(),
    }

    await expect(cancelSession(socket as never, 'session-1')).rejects.toThrow('cancel denied')
    expect(emitWithAck).toHaveBeenCalledWith('client:cancel', expect.objectContaining({
      sessionId: 'session-1',
      operationId: expect.any(String),
    }))
  })

  it('throws business errors from ACK envelopes without retrying', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: false, error: 'IMAGE_TOO_LARGE: reduce the image size' })
    const socket = {
      connected: true,
      active: true,
      timeout: () => ({ emitWithAck }),
      connect: vi.fn(),
    }
    await expect(emitRpc(socket as never, 'client:test', {}, { attempts: 3 })).rejects.toThrow('IMAGE_TOO_LARGE')
    expect(emitWithAck).toHaveBeenCalledTimes(1)
  })
})
