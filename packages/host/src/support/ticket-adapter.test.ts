import { describe, expect, it, vi } from 'vitest'
import { ZammadTicketAdapter } from './ticket-adapter.js'

describe('Zammad support adapter', () => {
  it('stores only ticket identity/link in the product boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 42 }), { status: 201 }))
    const adapter = new ZammadTicketAdapter({ origin: 'https://support.test', token: 'token', group: 'RunLab', fetchImpl })
    await expect(adapter.create({ organizationId: 'org_a', subject: 'Help', description: 'Problem', traceId: 'trace' })).resolves.toEqual({ id: '42', url: 'https://support.test/ticket/zoom/42' })
  })

  it('redacts support payload before sending it to the ticket system', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 43 }), { status: 201 }))
    const adapter = new ZammadTicketAdapter({ origin: 'https://support.test', token: 'ticket-token', group: 'RunLab', fetchImpl })

    await adapter.create({
      organizationId: 'org_a',
      subject: 'Help',
      description: 'Failed with Bearer user-secret and OPENAI_API_KEY=not-a-real-test-fixture',
      traceId: 'trace-1',
      bundleUrl: 'https://storage.example/bundle.zip?X-Amz-Signature=secret',
    })

    const [, init] = fetchImpl.mock.calls[0]!
    const payload = JSON.parse(String(init?.body)) as { article: { body: string } }
    expect(payload.article.body).toContain('Failed with ******')
    expect(payload.article.body).toContain('OPENAI_API_KEY=[redacted]')
    expect(payload.article.body).toContain('Bundle: <https://redacted>/bundle.zip?<query-redacted>')
    expect(payload.article.body).not.toContain('user-secret')
    expect(payload.article.body).not.toContain('X-Amz-Signature=secret')
  })
})
