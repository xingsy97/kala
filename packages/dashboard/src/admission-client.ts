import type { MessageContent } from '@agent-kernel/kernel'

import { randomId } from './lib/random-id.js'

export type AdmissionAccepted = {
  accepted: true
  duplicate: boolean
  operationId: string
  sequence: number
  state: 'pending' | 'leased' | 'committed' | 'expired'
  routeGeneration: number
}

export async function admitUserMessage(input: {
  host: string
  token?: string
  sessionId: string
  text: string
  mode: 'queue' | 'steer'
  content?: readonly MessageContent[]
  operationId?: string
  timeoutMs?: number
  attempts?: number
}): Promise<AdmissionAccepted> {
  const operationId = input.operationId ?? randomId()
  const attempts = input.attempts ?? 3
  const timeoutMs = input.timeoutMs ?? 10_000
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${input.host.replace(/\/$/u, '')}/runtime/admission/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({
          sessionId: input.sessionId, operationId, text: input.text, mode: input.mode,
          ...(input.content ? { content: input.content } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = await response.json().catch(() => ({})) as Partial<AdmissionAccepted> & { error?: string }
      if (!response.ok) {
        const error = new Error(body.error ?? `admission returned ${response.status}`)
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new AdmissionBusinessError(error.message)
        throw error
      }
      if (body.accepted !== true || body.operationId !== operationId || !Number.isSafeInteger(body.sequence)) {
        throw new Error('invalid admission acknowledgement')
      }
      return body as AdmissionAccepted
    } catch (error) {
      if (error instanceof AdmissionBusinessError) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'admission failed'))
}

class AdmissionBusinessError extends Error {}
