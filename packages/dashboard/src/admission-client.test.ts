import { afterEach, describe, expect, it, vi } from 'vitest'

import { admitUserMessage } from './admission-client.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('admitUserMessage', () => {
  it('retries transport failure with one stable operation identity', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accepted: true, duplicate: true, operationId: 'operation-0001', sequence: 8, state: 'pending', routeGeneration: 3,
      }), { status: 202, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(admitUserMessage({ host: 'https://runlab.example/', token: 'private-token', sessionId: 'session-1', operationId: 'operation-0001', text: 'continue', mode: 'queue' })).resolves.toMatchObject({ accepted: true, duplicate: true, operationId: 'operation-0001' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('https://runlab.example/runtime/admission/messages')
      expect(call[1]).toMatchObject({ method: 'POST', credentials: 'include', headers: { authorization: 'Bearer private-token' } })
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({ operationId: 'operation-0001', sessionId: 'session-1' })
    }
  })

  it('does not retry a permanent validation failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid admission message' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(admitUserMessage({ host: '', sessionId: 'session-1', operationId: 'operation-0002', text: 'bad', mode: 'steer' })).rejects.toThrow('invalid admission message')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
