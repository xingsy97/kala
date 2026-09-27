import { createHash } from 'node:crypto'

import type { RpcAck } from '@agent-kernel/shared'

const MAX_COMPLETED_OPERATIONS = 2_000
const OPERATION_TTL_MS = 10 * 60_000
const PAYLOAD_CONFLICT_ERROR = 'operationId was already used with a different payload'

export type OperationScope = {
  principal: string
  sessionId: string
  eventKind: string
}

type Entry = {
  expiresAt: number
  payloadHash: string
  result: RpcAck<unknown>
}

type PendingEntry = {
  payloadHash: string
  result: Promise<RpcAck<unknown>>
}

export class OperationDeduper {
  private readonly completed = new Map<string, Entry>()
  private readonly pending = new Map<string, PendingEntry>()

  async run<T>(
    operationId: string | undefined,
    scope: OperationScope,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<RpcAck<T>> {
    if (!operationId) return await execute(operation)
    this.prune()
    const key = operationKey(scope, operationId)
    const payloadHash = hashPayload(payload)
    const completed = this.completed.get(key)
    if (completed) {
      return completed.payloadHash === payloadHash
        ? completed.result as RpcAck<T>
        : payloadConflict<T>()
    }
    const pending = this.pending.get(key)
    if (pending) {
      return pending.payloadHash === payloadHash
        ? await pending.result as RpcAck<T>
        : payloadConflict<T>()
    }

    const result = execute(operation) as Promise<RpcAck<unknown>>
    this.pending.set(key, { payloadHash, result })
    const settled = await result
    this.pending.delete(key)
    this.completed.set(key, {
      expiresAt: Date.now() + OPERATION_TTL_MS,
      payloadHash,
      result: settled,
    })
    this.prune()
    return settled as RpcAck<T>
  }

  private prune(): void {
    const now = Date.now()
    for (const [key, entry] of this.completed) {
      if (entry.expiresAt <= now) this.completed.delete(key)
    }
    while (this.completed.size > MAX_COMPLETED_OPERATIONS) {
      const oldest = this.completed.keys().next().value
      if (oldest === undefined) break
      this.completed.delete(oldest)
    }
  }
}

function operationKey(scope: OperationScope, operationId: string): string {
  return JSON.stringify([scope.principal, scope.sessionId, scope.eventKind, operationId])
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? 'undefined'
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalValue(item))
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, canonicalValue(object[key])]),
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (typeof value === 'bigint') return value.toString()
  return value
}

function payloadConflict<T>(): RpcAck<T> {
  return { ok: false, error: PAYLOAD_CONFLICT_ERROR }
}

async function execute<T>(operation: () => Promise<T>): Promise<RpcAck<T>> {
  try {
    const value = await operation()
    return value === undefined
      ? ({ ok: true } as RpcAck<T>)
      : ({ ok: true, value } as RpcAck<T>)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
