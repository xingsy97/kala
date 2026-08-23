import { createHash } from 'node:crypto'

import { readJsonFile, writeJsonFile } from './atomic-json-file.js'

export type AdmissionMessage = {
  schemaVersion: 1
  principalDigest: string
  unitId: 'local'
  sessionId: string
  operationId: string
  mode: 'queue' | 'steer'
  text: string
  content?: readonly unknown[]
}

export type AdmissionRecord = AdmissionMessage & {
  sequence: number
  bodyDigest: string
  acceptedAt: string
  state: 'pending' | 'leased' | 'committed' | 'failed' | 'expired'
  routeGeneration: number
  leaseGeneration?: number
  leaseOwner?: string
  leaseExpiresAt?: string
  committedAt?: string
  failedAt?: string
  sessionCursor?: number
  attempts?: number
  lastAttemptAt?: string
  error?: string
}

export type AdmissionOperationStatus = {
  operationId: string
  sessionId: string
  sequence: number
  state: AdmissionRecord['state']
  acceptedAt: string
  routeGeneration: number
  attempts: number
  lastAttemptAt?: string
  lastError?: string
  committedAt?: string
  failedAt?: string
  sessionCursor?: number
}

type LedgerState = { schemaVersion: 1; revision: number; nextSequence: number; capacity: number; records: AdmissionRecord[] }
const messageFields = new Set(['schemaVersion', 'principalDigest', 'unitId', 'sessionId', 'operationId', 'mode', 'text', 'content'])
const recordFields = new Set([...messageFields, 'sequence', 'bodyDigest', 'acceptedAt', 'state', 'routeGeneration', 'leaseGeneration', 'leaseOwner', 'leaseExpiresAt', 'committedAt', 'failedAt', 'sessionCursor', 'attempts', 'lastAttemptAt', 'error'])

export class DedicatedAdmissionLedger {
  private mutation = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly capacity = 1000,
    private readonly committedRetentionMs = 30 * 24 * 60 * 60 * 1000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('admission capacity must be a positive integer')
    if (!Number.isSafeInteger(committedRetentionMs) || committedRetentionMs < 1) throw new Error('admission retention must be a positive integer')
  }

  async append(message: AdmissionMessage, routeGeneration: number): Promise<{ record: AdmissionRecord; duplicate: boolean }> {
    return await this.serialize(async () => {
      if (!Number.isSafeInteger(routeGeneration) || routeGeneration < 0) throw new Error('invalid admission route generation')
      const normalized = parseAdmissionMessage(message)
      const state = await this.read()
      expireTerminal(state, this.committedRetentionMs)
      const bodyDigest = digest(normalized)
      const existing = state.records.find((record) => record.operationId === normalized.operationId)
      if (existing) {
        if (existing.bodyDigest !== bodyDigest) throw new Error('admission operationId conflicts with an existing request')
        return { record: { ...existing }, duplicate: true }
      }
      if (state.records.filter((record) => record.state === 'pending' || record.state === 'leased').length >= state.capacity) {
        throw new AdmissionBackpressureError('admission queue capacity exceeded')
      }
      const record: AdmissionRecord = {
        ...normalized, sequence: state.nextSequence, bodyDigest, acceptedAt: new Date().toISOString(),
        state: 'pending', routeGeneration,
      }
      state.nextSequence += 1
      state.records.push(record)
      await this.persist(state)
      return { record: { ...record }, duplicate: false }
    })
  }

  async leaseNext(owner: string, routeGeneration: number, leaseMs = 30_000, excludedSessionIds: ReadonlySet<string> = new Set()): Promise<AdmissionRecord | undefined> {
    return await this.serialize(async () => {
      if (!owner || !Number.isSafeInteger(routeGeneration) || routeGeneration < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
        throw new Error('invalid admission lease request')
      }
      const state = await this.read()
      const now = Date.now()
      let changed = false
      for (const record of state.records) {
        if (record.state === 'leased' && (record.leaseGeneration !== routeGeneration || Date.parse(record.leaseExpiresAt ?? '') <= now)) {
          record.state = 'pending'
          delete record.leaseOwner
          delete record.leaseExpiresAt
          delete record.leaseGeneration
          changed = true
        }
      }
      const record = state.records.find((candidate) =>
        candidate.state === 'pending'
        && !excludedSessionIds.has(candidate.sessionId)
        && !state.records.some((prior) =>
          prior.sessionId === candidate.sessionId
          && prior.sequence < candidate.sequence
          && prior.state !== 'committed'
          && prior.state !== 'failed'
          && prior.state !== 'expired',
        ),
      )
      if (!record) {
        if (changed) await this.persist(state)
        return undefined
      }
      record.state = 'leased'
      record.leaseOwner = owner
      record.leaseGeneration = routeGeneration
      record.leaseExpiresAt = new Date(now + leaseMs).toISOString()
      record.attempts = (record.attempts ?? 0) + 1
      record.lastAttemptAt = new Date(now).toISOString()
      await this.persist(state)
      return { ...record }
    })
  }

  async commit(operationId: string, owner: string, routeGeneration: number, sessionCursor?: number): Promise<AdmissionRecord> {
    return await this.serialize(async () => {
      const state = await this.read()
      const record = state.records.find((item) => item.operationId === operationId)
      if (!record) throw new Error('admission record not found')
      if (record.state === 'committed' || record.state === 'failed' || record.state === 'expired') return { ...record }
      if (record.state !== 'leased' || record.leaseOwner !== owner || record.leaseGeneration !== routeGeneration) {
        throw new Error('stale admission lease')
      }
      if (sessionCursor !== undefined && (!Number.isSafeInteger(sessionCursor) || sessionCursor < 0)) throw new Error('invalid Session cursor')
      record.state = 'committed'
      record.committedAt = new Date().toISOString()
      if (sessionCursor !== undefined) record.sessionCursor = sessionCursor
      delete record.leaseOwner
      delete record.leaseExpiresAt
      delete record.leaseGeneration
      await this.persist(state)
      return { ...record }
    })
  }

  async committed(operationId: string, routeGeneration: number, sessionCursor?: number): Promise<AdmissionRecord> {
    return await this.serialize(async () => {
      const state = await this.read()
      const record = state.records.find((item) => item.operationId === operationId)
      if (!record) throw new Error('admission record not found')
      if (record.state === 'committed' || record.state === 'failed' || record.state === 'expired') return { ...record }
      if (record.state !== 'leased' || record.leaseGeneration !== routeGeneration) throw new Error('stale admission lease')
      if (sessionCursor !== undefined && (!Number.isSafeInteger(sessionCursor) || sessionCursor < 0)) throw new Error('invalid Session cursor')
      record.state = 'committed'
      record.committedAt = new Date().toISOString()
      if (sessionCursor !== undefined) record.sessionCursor = sessionCursor
      delete record.leaseOwner
      delete record.leaseExpiresAt
      delete record.leaseGeneration
      await this.persist(state)
      return { ...record }
    })
  }

  async release(operationId: string, owner: string, error?: string): Promise<void> {
    await this.serialize(async () => {
      const state = await this.read()
      const record = state.records.find((item) => item.operationId === operationId)
      if (!record || record.state !== 'leased' || record.leaseOwner !== owner) return
      record.state = 'pending'
      record.error = redacted(error)
      delete record.leaseOwner
      delete record.leaseExpiresAt
      delete record.leaseGeneration
      await this.persist(state)
    })
  }

  async fail(operationId: string, owner: string, routeGeneration: number, error: string): Promise<AdmissionRecord> {
    return await this.serialize(async () => {
      const state = await this.read()
      const record = state.records.find((item) => item.operationId === operationId)
      if (!record) throw new Error('admission record not found')
      if (record.state === 'failed' || record.state === 'committed' || record.state === 'expired') return { ...record }
      if (record.state !== 'leased' || record.leaseOwner !== owner || record.leaseGeneration !== routeGeneration) {
        throw new Error('stale admission lease')
      }
      record.state = 'failed'
      record.failedAt = new Date().toISOString()
      record.error = redacted(error)
      delete record.leaseOwner
      delete record.leaseExpiresAt
      delete record.leaseGeneration
      await this.persist(state)
      return { ...record }
    })
  }

  async operation(operationId: string, principalDigest: string): Promise<AdmissionOperationStatus | undefined> {
    const state = await this.read()
    const record = state.records.find((item) => item.operationId === operationId && item.principalDigest === principalDigest)
    if (!record) return undefined
    return {
      operationId: record.operationId, sessionId: record.sessionId, sequence: record.sequence, state: record.state,
      acceptedAt: record.acceptedAt, routeGeneration: record.routeGeneration, attempts: record.attempts ?? 0,
      ...(record.lastAttemptAt ? { lastAttemptAt: record.lastAttemptAt } : {}),
      ...(record.error ? { lastError: record.error } : {}),
      ...(record.committedAt ? { committedAt: record.committedAt } : {}),
      ...(record.failedAt ? { failedAt: record.failedAt } : {}),
      ...(record.sessionCursor !== undefined ? { sessionCursor: record.sessionCursor } : {}),
    }
  }

  async snapshot(): Promise<{ revision: number; pending: number; leased: number; committed: number; failed: number; expired: number; oldestAgeMs: number; capacity: number }> {
    const state = await this.read()
    const now = Date.now()
    const active = state.records.filter((record) => record.state === 'pending' || record.state === 'leased')
    return {
      revision: state.revision,
      pending: state.records.filter((record) => record.state === 'pending').length,
      leased: state.records.filter((record) => record.state === 'leased').length,
      committed: state.records.filter((record) => record.state === 'committed').length,
      failed: state.records.filter((record) => record.state === 'failed').length,
      expired: state.records.filter((record) => record.state === 'expired').length,
      oldestAgeMs: active.length ? Math.max(0, now - Math.min(...active.map((record) => Date.parse(record.acceptedAt)))) : 0,
      capacity: state.capacity,
    }
  }

  private async read(): Promise<LedgerState> {
    const state = await readJsonFile<unknown>(this.path)
    return state === undefined
      ? { schemaVersion: 1, revision: 0, nextSequence: 1, capacity: this.capacity, records: [] }
      : parseLedgerState(state)
  }

  private async persist(state: LedgerState): Promise<void> {
    state.revision += 1
    await writeJsonFile(this.path, state)
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(() => undefined, () => undefined)
    return await result
  }
}

export class AdmissionBackpressureError extends Error {}

function parseAdmissionMessage(value: AdmissionMessage): AdmissionMessage {
  if (
    value?.schemaVersion !== 1 || value.unitId !== 'local' || !/^[a-f0-9]{64}$/u.test(value.principalDigest)
    || typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 200
    || typeof value.operationId !== 'string' || value.operationId.length < 1 || value.operationId.length > 128
    || !['queue', 'steer'].includes(value.mode) || typeof value.text !== 'string'
    || (!value.text.trim() && !value.content?.length) || (value.content !== undefined && !Array.isArray(value.content))
  ) throw new Error('invalid admission message')
  rejectUnknownFields(value as unknown as Record<string, unknown>, messageFields, 'admission message')
  canonicalJson(value)
  return { ...value, ...(value.content ? { content: structuredClone(value.content) } : {}) }
}

function parseLedgerState(value: unknown): LedgerState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid admission ledger')
  const state = value as Partial<LedgerState>
  if (
    state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || (state.revision ?? -1) < 0
    || !Number.isSafeInteger(state.nextSequence) || (state.nextSequence ?? 0) < 1
    || !Number.isSafeInteger(state.capacity) || (state.capacity ?? 0) < 1 || !Array.isArray(state.records)
  ) throw new Error('invalid admission ledger')
  rejectUnknownFields(state as Record<string, unknown>, new Set(['schemaVersion', 'revision', 'nextSequence', 'capacity', 'records']), 'admission ledger')
  let previousSequence = 0
  const operationIds = new Set<string>()
  for (const record of state.records) {
    if (
      !record || typeof record !== 'object' || record.schemaVersion !== 1 || record.unitId !== 'local'
      || !/^[a-f0-9]{64}$/u.test(record.principalDigest) || typeof record.sessionId !== 'string'
      || typeof record.operationId !== 'string' || typeof record.bodyDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(record.bodyDigest) || !Number.isSafeInteger(record.sequence)
      || record.sequence <= previousSequence || operationIds.has(record.operationId)
      || !['pending', 'leased', 'committed', 'failed', 'expired'].includes(record.state)
      || !Number.isFinite(Date.parse(record.acceptedAt))
      || (record.attempts !== undefined && (!Number.isSafeInteger(record.attempts) || record.attempts < 0))
      || (record.lastAttemptAt !== undefined && !Number.isFinite(Date.parse(record.lastAttemptAt)))
    ) throw new Error('invalid admission ledger record')
    rejectUnknownFields(record as unknown as Record<string, unknown>, recordFields, 'admission ledger record')
    if (record.state === 'leased' && (!record.leaseOwner || !Number.isSafeInteger(record.leaseGeneration) || !Number.isFinite(Date.parse(record.leaseExpiresAt ?? '')))) {
      throw new Error('invalid admission lease')
    }
    if (record.state !== 'leased' && (record.leaseOwner !== undefined || record.leaseGeneration !== undefined || record.leaseExpiresAt !== undefined)) throw new Error('inactive admission record retains a lease')
    if (record.state === 'committed' && !Number.isFinite(Date.parse(record.committedAt ?? ''))) throw new Error('committed admission record lacks a receipt timestamp')
    if (record.state === 'failed' && !Number.isFinite(Date.parse(record.failedAt ?? ''))) throw new Error('failed admission record lacks a receipt timestamp')
    if (record.state === 'expired' && !Number.isFinite(Date.parse(record.committedAt ?? record.failedAt ?? ''))) throw new Error('expired admission record lacks a receipt timestamp')
    if (record.committedAt !== undefined && record.failedAt !== undefined) throw new Error('admission record contains conflicting terminal evidence')
    if (record.state === 'committed' && record.failedAt !== undefined) throw new Error('committed admission record contains failure evidence')
    if (record.state === 'failed' && record.committedAt !== undefined) throw new Error('failed admission record contains commit evidence')
    if ((record.state === 'pending' || record.state === 'leased') && (record.committedAt !== undefined || record.failedAt !== undefined || record.sessionCursor !== undefined)) throw new Error('uncommitted admission record contains terminal evidence')
    if ((record.state === 'failed' || (record.state === 'expired' && record.failedAt !== undefined)) && record.sessionCursor !== undefined) throw new Error('failed admission record contains a Session cursor')
    previousSequence = record.sequence
    operationIds.add(record.operationId)
  }
  if ((state.nextSequence ?? 0) <= previousSequence) throw new Error('invalid admission next sequence')
  return state as LedgerState
}

function expireTerminal(state: LedgerState, retentionMs: number): void {
  const cutoff = Date.now() - retentionMs
  for (const record of state.records) {
    if (record.state === 'committed' && Date.parse(record.committedAt ?? record.acceptedAt) < cutoff) record.state = 'expired'
    if (record.state === 'failed' && Date.parse(record.failedAt ?? record.acceptedAt) < cutoff) record.state = 'expired'
  }
}

function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }

function canonicalJson(value: unknown): string {
  const seen = new Set<object>()
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('admission message must contain finite JSON numbers')
      return input
    }
    if (Array.isArray(input)) return input.map(normalize)
    if (!input || typeof input !== 'object') throw new Error('admission message must be JSON serializable')
    if (seen.has(input)) throw new Error('admission message must not be cyclic')
    seen.add(input)
    const output = Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]))
    seen.delete(input)
    return output
  }
  return JSON.stringify(normalize(value))
}

function redacted(value?: string): string | undefined {
  return value?.replaceAll(/(?:[A-Za-z]:)?[\/][^\s;]+/gu, '<path>').slice(0, 500)
}
function rejectUnknownFields(input: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void { for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown ${name} field: ${key}`) }
