import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  isExecutorInstallStatusTransitionAllowed,
  type CreateExecutorInstall,
  type ExecutorInstallEvent,
  type ExecutorInstallEventMetadata,
  type ExecutorInstallStatus,
  type ExecutorInstallStatusSnapshot,
  type UpdateExecutorInstall,
} from '@agent-kernel/shared'

const DEFAULT_TTL_MS = 15 * 60_000

type InstallationRecord = ExecutorInstallStatusSnapshot & {
  bootstrapHash: string
  setupCodeHash?: string
  bootstrapDownloadedAt?: string
  redeemedAt?: string
  workspaceId?: string
  events: ExecutorInstallEvent[]
}

type FileShape = { schemaVersion: 1; installations: InstallationRecord[]; idempotency: Record<string, string> }

export type CreatedExecutorInstallation = { install: ExecutorInstallStatusSnapshot; setupCode: string }
export type ClaimedExecutorInstallation = { install: ExecutorInstallStatusSnapshot; bootstrap: string }

export class ExecutorInstallationStore {
  private records = new Map<string, InstallationRecord>()
  private idempotency = new Map<string, string>()

  constructor(private readonly path: string, private readonly ttlMs = DEFAULT_TTL_MS) {}

  load(): void {
    if (!existsSync(this.path)) return
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as FileShape
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.installations)) return
    this.records = new Map(parsed.installations.filter(validRecord).map((record) => [record.id, record]))
    this.idempotency = new Map(Object.entries(parsed.idempotency ?? {}).filter(([, id]) => this.records.has(id)))
  }

  create(input: CreateExecutorInstall, idempotencyKey?: string): CreatedExecutorInstallation {
    if (idempotencyKey) {
      const existingId = this.idempotency.get(idempotencyKey)
      const existing = existingId ? this.records.get(existingId) : undefined
      if (existing) throw new ExecutorInstallationError('idempotency_replayed', 409, this.snapshot(existing))
    }
    const now = new Date()
    const id = `inst_${randomBytes(12).toString('base64url')}`
    const setupCode = createSetupCode()
    const record: InstallationRecord = {
      id,
      ...input,
      status: 'created',
      seq: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      bootstrapHash: hashToken(`unclaimed:${randomBytes(32).toString('base64url')}`),
      setupCodeHash: hashToken(setupCode),
      events: [{ installationId: id, seq: 0, timestamp: now.toISOString(), status: 'created' }],
    }
    this.records.set(id, record)
    if (idempotencyKey) this.idempotency.set(idempotencyKey, id)
    this.save()
    return { install: this.snapshot(record), setupCode }
  }

  claim(setupCode: string): ClaimedExecutorInstallation | undefined {
    const normalized = normalizeSetupCode(setupCode)
    if (!normalized) return undefined
    const hash = hashToken(normalized)
    const record = [...this.records.values()].find((candidate) => candidate.setupCodeHash && safeHashEqual(candidate.setupCodeHash, hash))
    if (!record || record.status !== 'created' || record.bootstrapDownloadedAt) return undefined
    const bootstrap = `ak_install_${randomBytes(32).toString('base64url')}`
    record.bootstrapHash = hashToken(bootstrap)
    delete record.setupCodeHash
    record.bootstrapDownloadedAt = new Date().toISOString()
    this.transitionRecord(record, 'bootstrap_downloaded')
    return { install: this.snapshot(record), bootstrap }
  }

  get(id: string): ExecutorInstallStatusSnapshot | undefined {
    const record = this.activeRecord(id)
    return record ? this.snapshot(record) : undefined
  }

  events(id: string, afterSeq = -1): readonly ExecutorInstallEvent[] | undefined {
    const record = this.activeRecord(id)
    return record?.events.filter((event) => event.seq > afterSeq)
  }

  update(id: string, input: UpdateExecutorInstall): ExecutorInstallStatusSnapshot | undefined {
    const record = this.activeRecord(id)
    if (!record || record.status !== 'created' || record.bootstrapDownloadedAt) return undefined
    Object.assign(record, input, { updatedAt: new Date().toISOString() })
    this.save()
    return this.snapshot(record)
  }

  delete(id: string): boolean {
    if (!this.records.delete(id)) return false
    for (const [key, value] of this.idempotency) if (value === id) this.idempotency.delete(key)
    this.save()
    return true
  }

  authenticate(id: string, bootstrap: string | undefined): boolean {
    const record = this.activeRecord(id)
    return Boolean(record && bootstrap && safeHashEqual(record.bootstrapHash, hashToken(bootstrap)))
  }

  markBootstrapDownloaded(bootstrap: string): ExecutorInstallStatusSnapshot | undefined {
    const record = this.findByBootstrap(bootstrap)
    if (!record || record.bootstrapDownloadedAt || record.redeemedAt || record.status !== 'created') return undefined
    record.bootstrapDownloadedAt = new Date().toISOString()
    this.transitionRecord(record, 'bootstrap_downloaded')
    return this.snapshot(record)
  }

  reportClient(id: string, bootstrap: string, status: ExecutorInstallStatus, errorCode?: string, metadata?: ExecutorInstallEventMetadata): ExecutorInstallStatusSnapshot {
    const record = this.requireBootstrap(id, bootstrap)
    if (status === 'online' || status === 'completed') throw new ExecutorInstallationError('host_observed_status_required', 409)
    this.transitionRecord(record, status, errorCode, metadata)
    // A Dashboard-created installation token is already an explicit operator
    // authorization. Pairing remains for generic/unknown Executor flows, but
    // the dedicated install session advances without a second approval click.
    if (status === 'pairing_pending') this.transitionRecord(record, 'paired')
    return this.snapshot(record)
  }

  approve(id: string): ExecutorInstallStatusSnapshot | undefined {
    const record = this.activeRecord(id)
    if (!record || record.status !== 'pairing_pending') return undefined
    this.transitionRecord(record, 'paired')
    return this.snapshot(record)
  }

  reject(id: string): ExecutorInstallStatusSnapshot | undefined {
    const record = this.activeRecord(id)
    if (!record || record.status !== 'pairing_pending') return undefined
    this.transitionRecord(record, 'rejected')
    return this.snapshot(record)
  }

  redeem(id: string, bootstrap: string, workspaceId: string): ExecutorInstallStatusSnapshot {
    const record = this.requireBootstrap(id, bootstrap)
    if (record.status !== 'paired') throw new ExecutorInstallationError('installation_not_approved', 409)
    if (record.redeemedAt) throw new ExecutorInstallationError('installation_already_redeemed', 409)
    record.redeemedAt = new Date().toISOString()
    record.workspaceId = workspaceId
    this.save()
    return this.snapshot(record)
  }

  markOnline(id: string, workspaceId: string, metadata?: ExecutorInstallEventMetadata): ExecutorInstallStatusSnapshot | undefined {
    const record = this.activeRecord(id)
    if (!record || record.workspaceId !== workspaceId || record.status !== 'starting') return undefined
    this.transitionRecord(record, 'online', undefined, metadata)
    this.transitionRecord(record, 'completed', undefined, metadata)
    return this.snapshot(record)
  }

  private activeRecord(id: string): InstallationRecord | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    if (Date.parse(record.expiresAt) <= Date.now() && ['created', 'pairing_pending'].includes(record.status)) {
      this.transitionRecord(record, 'expired')
    }
    return record
  }

  private requireBootstrap(id: string, bootstrap: string): InstallationRecord {
    const record = this.activeRecord(id)
    if (!record || !safeHashEqual(record.bootstrapHash, hashToken(bootstrap))) {
      throw new ExecutorInstallationError('invalid_installation_credential', 401)
    }
    return record
  }

  private findByBootstrap(bootstrap: string): InstallationRecord | undefined {
    const hash = hashToken(bootstrap)
    return [...this.records.values()].find((record) => safeHashEqual(record.bootstrapHash, hash))
  }

  private transitionRecord(record: InstallationRecord, status: ExecutorInstallStatus, errorCode?: string, metadata?: ExecutorInstallEventMetadata): void {
    if (!isExecutorInstallStatusTransitionAllowed(record.status, status, record.mode)) {
      throw new ExecutorInstallationError(`invalid_installation_transition:${record.status}:${status}`, 409)
    }
    const timestamp = new Date().toISOString()
    record.status = status
    record.seq += 1
    record.updatedAt = timestamp
    if (errorCode) record.errorCode = errorCode
    record.events.push({ installationId: record.id, seq: record.seq, timestamp, status, ...(errorCode ? { errorCode } : {}), ...(metadata ? { metadata } : {}) })
    this.save()
  }

  private snapshot(record: InstallationRecord): ExecutorInstallStatusSnapshot {
    const { bootstrapHash: _bootstrapHash, setupCodeHash: _setupCodeHash, bootstrapDownloadedAt: _downloaded, redeemedAt: _redeemed, workspaceId: _workspaceId, events: _events, ...snapshot } = record
    return { ...snapshot }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    const body: FileShape = { schemaVersion: 1, installations: [...this.records.values()], idempotency: Object.fromEntries(this.idempotency) }
    try {
      writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      const fd = openSync(temp, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temp, this.path)
    } finally { rmSync(temp, { force: true }) }
  }
}

export class ExecutorInstallationError extends Error {
  constructor(message: string, readonly status: number, readonly snapshot?: ExecutorInstallStatusSnapshot) { super(message) }
}

function createSetupCode(): string { return randomBytes(5).toString('hex').toUpperCase() }
function normalizeSetupCode(value: string): string | undefined { const code = value.replaceAll('-', '').trim().toUpperCase(); return /^[A-F0-9]{10}$/u.test(code) ? code : undefined }
function hashToken(token: string): string { return `sha256:${createHash('sha256').update(token).digest('hex')}` }
function safeHashEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
function validRecord(value: InstallationRecord): boolean { return typeof value?.id === 'string' && typeof value.bootstrapHash === 'string' && Array.isArray(value.events) }
