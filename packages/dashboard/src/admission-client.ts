import type { MessageContent } from '@agent-kernel/kernel'

import { randomId } from './lib/random-id.js'

export type AdmissionAccepted = {
  accepted: true
  duplicate: boolean
  operationId: string
  sequence: number
  state: 'pending' | 'leased' | 'committed' | 'failed' | 'expired'
  routeGeneration: number
}

export type AdmissionOperationStatus = {
  operationId: string
  sessionId: string
  sequence: number
  state: 'pending' | 'leased' | 'committed' | 'failed' | 'expired'
  acceptedAt: string
  routeGeneration: number
  attempts: number
  lastAttemptAt?: string
  lastError?: string
  committedAt?: string
  failedAt?: string
  sessionCursor?: number
}

export class AdmissionDeliveryPendingError extends Error {
  readonly durablyAccepted = true
  constructor(
    readonly operationId: string,
    readonly attempts: number,
    readonly lastError?: string,
  ) {
    super('message was durably accepted but has not reached the Session log yet')
  }
}

export class AdmissionDeliveryFailedError extends Error {
  readonly durablyAccepted = true
  constructor(readonly operationId: string, readonly lastError?: string, readonly state: 'failed' | 'expired' = 'failed') {
    super(lastError ?? (state === 'expired' ? 'message delivery expired before reaching the target Session' : 'message could not be delivered to the target Session'))
  }
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
  deliveryTimeoutMs?: number
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
      const accepted = body as AdmissionAccepted
      // Portable mode commits in-process and has no durable Ingress ledger.
      // Platform mode returns a positive route generation and must prove the
      // accepted operation reached Session JSONL before the UI calls it done.
      if (accepted.state !== 'committed' && accepted.routeGeneration > 0) {
        await waitForAdmissionDelivery({
          host: input.host, token: input.token, operationId,
          timeoutMs: input.deliveryTimeoutMs ?? 15_000,
        })
      }
      return accepted
    } catch (error) {
      if (error instanceof AdmissionBusinessError || error instanceof AdmissionDeliveryPendingError || error instanceof AdmissionDeliveryFailedError) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'admission failed'))
}

export async function admissionOperationStatus(input: { host: string; token?: string; operationId: string; timeoutMs?: number }): Promise<AdmissionOperationStatus> {
  const response = await fetch(`${input.host.replace(/\/$/u, '')}/runtime/admission/messages/${encodeURIComponent(input.operationId)}`, {
    headers: { ...(input.token ? { authorization: `Bearer ${input.token}` } : {}) },
    credentials: 'include',
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  })
  const body = await response.json().catch(() => ({})) as Partial<AdmissionOperationStatus> & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `admission status returned ${response.status}`)
  if (body.operationId !== input.operationId || !['pending', 'leased', 'committed', 'failed', 'expired'].includes(body.state ?? '') || !Number.isSafeInteger(body.attempts)) {
    throw new Error('invalid admission operation status')
  }
  return body as AdmissionOperationStatus
}

async function waitForAdmissionDelivery(input: { host: string; token?: string; operationId: string; timeoutMs: number }): Promise<AdmissionOperationStatus> {
  const deadline = Date.now() + input.timeoutMs
  let last: AdmissionOperationStatus | undefined
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      last = await admissionOperationStatus({ ...input, timeoutMs: Math.min(5_000, Math.max(1, deadline - Date.now())) })
      if (last.state === 'committed') return last
      if (last.state === 'failed') throw new AdmissionDeliveryFailedError(last.operationId, last.lastError)
      if (last.state === 'expired') throw new AdmissionDeliveryFailedError(last.operationId, last.lastError, 'expired')
    } catch (error) { lastError = error }
    if (lastError instanceof AdmissionDeliveryFailedError) throw lastError
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))))
  }
  throw new AdmissionDeliveryPendingError(
    input.operationId,
    last?.attempts ?? 0,
    last?.lastError ?? (lastError instanceof Error ? lastError.message : undefined),
  )
}

class AdmissionBusinessError extends Error {}
