import { describe, expect, it, vi } from 'vitest'
import { ZammadTicketAdapter } from './ticket-adapter.js'

describe('Zammad support adapter', () => {
  it('stores only ticket identity/link in the product boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 42 }), { status: 201 }))
    const adapter = new ZammadTicketAdapter({ origin: 'https://support.test', token: 'token', group: 'RunLab', fetchImpl })
    await expect(adapter.create({ organizationId: 'org_a', subject: 'Help', description: 'Problem', traceId: 'trace' })).resolves.toEqual({ id: '42', url: 'https://support.test/ticket/zoom/42' })
  })
})
