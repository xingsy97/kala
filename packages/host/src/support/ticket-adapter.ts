import { redactForPersistence } from '@agent-kernel/shared'

export type SupportTicketInput = { organizationId: string; subject: string; description: string; traceId?: string; bundleUrl?: string }
export interface SupportTicketAdapter { create(input: SupportTicketInput): Promise<{ id: string; url: string }> }
export class ZammadTicketAdapter implements SupportTicketAdapter {
  constructor(private readonly options: { origin: string; token: string; group: string; fetchImpl?: typeof fetch }) {}
  async create(input: SupportTicketInput): Promise<{ id: string; url: string }> {
    const safe = redactSupportTicketInput(input)
    const response = await (this.options.fetchImpl ?? fetch)(new URL('/api/v1/tickets', this.options.origin), { method: 'POST', headers: { authorization: `Token token=${this.options.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: safe.subject, group: this.options.group, customer: 'guess:runlab-support', article: { subject: safe.subject, body: `${safe.description}\n\nTrace: ${safe.traceId ?? 'not available'}\nBundle: ${safe.bundleUrl ?? 'not provided'}`, type: 'note', internal: false }, tags: [`organization:${safe.organizationId}`] }) })
    if (!response.ok) throw new Error(`support ticket creation failed: ${response.status}`)
    const body = await response.json() as { id?: number | string }
    if (body.id === undefined) throw new Error('support ticket response missing id')
    return { id: String(body.id), url: new URL(`/ticket/zoom/${body.id}`, this.options.origin).href }
  }
}

export function redactSupportTicketInput(input: SupportTicketInput): SupportTicketInput {
  const { value } = redactForPersistence(input, { maxStringLength: 8_000 })
  return value as SupportTicketInput
}
