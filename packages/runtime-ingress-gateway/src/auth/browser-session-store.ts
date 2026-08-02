import { createHash, randomUUID } from 'node:crypto'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import { readJsonFile, writeJsonFile } from '../persistence/atomic-json-file.js'
import type { EncryptedSecret } from './session-secret-box.js'

export type BrowserSessionRevocationReason = 'logout' | 'logout_all' | 'remote_logout' | 'expired' | 'refresh_failed' | 'administrator'

export type BrowserSession = {
  id: string
  tokenHash: string
  identity: AuthenticatedIdentity
  cacheNamespace: string
  device: { label: string; userAgent?: string }
  createdAt: number
  lastSeenAt: number
  idleExpiresAt: number
  absoluteExpiresAt: number
  providerRefreshAfter?: number
  refreshToken?: EncryptedSecret
  revokedAt?: number
  revocationReason?: BrowserSessionRevocationReason
}

export type CreateBrowserSessionInput = Omit<BrowserSession, 'id' | 'lastSeenAt' | 'revokedAt' | 'revocationReason'>

export interface BrowserSessionStore {
  create(input: CreateBrowserSessionInput): Promise<BrowserSession>
  findByTokenHash(tokenHash: string): Promise<BrowserSession | undefined>
  touch(sessionId: string, now: number, idleExpiresAt: number): Promise<BrowserSession | undefined>
  updateProvider(sessionId: string, expected: EncryptedSecret | undefined, update: { refreshToken?: EncryptedSecret; providerRefreshAfter?: number }): Promise<BrowserSession | undefined>
  listForIdentity(identity: AuthenticatedIdentity, now: number): Promise<readonly BrowserSession[]>
  revoke(sessionId: string, reason: BrowserSessionRevocationReason, now: number): Promise<boolean>
  revokeAllForIdentity(identity: AuthenticatedIdentity, reason: BrowserSessionRevocationReason, now: number, exceptSessionId?: string): Promise<number>
  prune(now: number): Promise<number>
}

type SessionFile = { schemaVersion: 1; sessions: BrowserSession[] }

export class FileBrowserSessionStore implements BrowserSessionStore {
  private readonly byId = new Map<string, BrowserSession>()
  private readonly idByTokenHash = new Map<string, string>()
  private mutation = Promise.resolve()

  constructor(
    readonly path: string,
    private readonly options: { maxEntries?: number; retainRevokedForMs?: number; touchPersistenceMs?: number } = {},
  ) {}

  async load(): Promise<void> {
    const file = await readJsonFile<SessionFile>(this.path)
    if (!file) return
    if (file.schemaVersion !== 1 || !Array.isArray(file.sessions)) throw new Error('unsupported browser session store')
    this.byId.clear()
    this.idByTokenHash.clear()
    for (const session of file.sessions) this.index(validateSession(session))
    await this.prune(Date.now())
  }

  async create(input: CreateBrowserSessionInput): Promise<BrowserSession> {
    return this.serialize(async () => {
      if (this.byId.size >= (this.options.maxEntries ?? 10_000)) throw new Error('too many browser sessions')
      if (this.idByTokenHash.has(input.tokenHash)) throw new Error('duplicate browser session token')
      const session: BrowserSession = { ...input, id: `bs_${randomUUID()}`, lastSeenAt: input.createdAt }
      this.index(session)
      try { await this.persist() } catch (error) { this.unindex(session); throw error }
      return session
    })
  }

  async findByTokenHash(tokenHash: string): Promise<BrowserSession | undefined> {
    const id = this.idByTokenHash.get(tokenHash)
    return id ? this.byId.get(id) : undefined
  }

  async touch(sessionId: string, now: number, idleExpiresAt: number): Promise<BrowserSession | undefined> {
    return this.serialize(async () => {
      const current = this.byId.get(sessionId)
      if (!current || !isLive(current, now)) return undefined
      const next: BrowserSession = {
        ...current,
        lastSeenAt: now,
        idleExpiresAt: Math.min(idleExpiresAt, current.absoluteExpiresAt),
      }
      this.byId.set(sessionId, next)
      if (now - current.lastSeenAt >= (this.options.touchPersistenceMs ?? 5 * 60_000)) await this.persist()
      return next
    })
  }

  async updateProvider(sessionId: string, expected: EncryptedSecret | undefined, update: { refreshToken?: EncryptedSecret; providerRefreshAfter?: number }): Promise<BrowserSession | undefined> {
    return this.serialize(async () => {
      const current = this.byId.get(sessionId)
      if (!current || !sameEncryptedSecret(current.refreshToken, expected)) return undefined
      const next = { ...current, ...update }
      this.byId.set(sessionId, next)
      await this.persist()
      return next
    })
  }

  async listForIdentity(identity: AuthenticatedIdentity, now: number): Promise<readonly BrowserSession[]> {
    return [...this.byId.values()]
      .filter((session) => sameIdentity(session.identity, identity) && isLive(session, now))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  async revoke(sessionId: string, reason: BrowserSessionRevocationReason, now: number): Promise<boolean> {
    return this.serialize(async () => {
      const session = this.byId.get(sessionId)
      if (!session || session.revokedAt !== undefined) return false
      this.byId.set(sessionId, { ...session, revokedAt: now, revocationReason: reason })
      await this.persist()
      return true
    })
  }

  async revokeAllForIdentity(identity: AuthenticatedIdentity, reason: BrowserSessionRevocationReason, now: number, exceptSessionId?: string): Promise<number> {
    return this.serialize(async () => {
      let count = 0
      for (const [id, session] of this.byId) {
        if (id === exceptSessionId || session.revokedAt !== undefined || !sameIdentity(session.identity, identity)) continue
        this.byId.set(id, { ...session, revokedAt: now, revocationReason: reason })
        count += 1
      }
      if (count > 0) await this.persist()
      return count
    })
  }

  async prune(now: number): Promise<number> {
    return this.serialize(async () => {
      const retain = this.options.retainRevokedForMs ?? 7 * 86_400_000
      let count = 0
      for (const session of [...this.byId.values()]) {
        const expired = now >= session.absoluteExpiresAt || now >= session.idleExpiresAt
        const oldRevoked = session.revokedAt !== undefined && now - session.revokedAt >= retain
        if (!expired && !oldRevoked) continue
        this.unindex(session)
        count += 1
      }
      if (count > 0) await this.persist()
      return count
    })
  }

  private index(session: BrowserSession): void {
    if (this.byId.has(session.id)) throw new Error('duplicate browser session id')
    if (this.idByTokenHash.has(session.tokenHash)) throw new Error('duplicate browser session token')
    this.byId.set(session.id, session)
    this.idByTokenHash.set(session.tokenHash, session.id)
  }

  private unindex(session: BrowserSession): void {
    this.byId.delete(session.id)
    this.idByTokenHash.delete(session.tokenHash)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist(): Promise<void> {
    await writeJsonFile(this.path, { schemaVersion: 1, sessions: [...this.byId.values()] } satisfies SessionFile)
  }
}

export function browserSessionTokenHash(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('base64url')
}

export function browserDeviceFromUserAgent(userAgent?: string): BrowserSession['device'] {
  const value = userAgent?.slice(0, 256)
  if (!value) return { label: 'Unknown browser' }
  const platform = /iPhone|iPad/u.test(value) ? 'iPhone or iPad' : /Android/u.test(value) ? 'Android' : /Macintosh/u.test(value) ? 'Mac' : /Windows/u.test(value) ? 'Windows PC' : 'Linux computer'
  const browser = /Edg\//u.test(value) ? 'Edge' : /Firefox\//u.test(value) ? 'Firefox' : /Chrome\//u.test(value) ? 'Chrome' : /Safari\//u.test(value) ? 'Safari' : 'Browser'
  return { label: `${browser} on ${platform}`, userAgent: value }
}

export function isLive(session: BrowserSession, now: number): boolean {
  return session.revokedAt === undefined && now < session.idleExpiresAt && now < session.absoluteExpiresAt
}

function sameIdentity(a: AuthenticatedIdentity, b: AuthenticatedIdentity): boolean { return a.issuer === b.issuer && a.subject === b.subject }
function sameEncryptedSecret(a?: EncryptedSecret, b?: EncryptedSecret): boolean {
  if (!a || !b) return a === b
  return a.keyId === b.keyId && a.iv === b.iv && a.ciphertext === b.ciphertext && a.tag === b.tag
}
function validateSession(session: BrowserSession): BrowserSession {
  if (!session.id?.startsWith('bs_') || !session.tokenHash || !session.identity?.issuer || !session.identity?.subject) throw new Error('invalid browser session record')
  for (const value of [session.createdAt, session.lastSeenAt, session.idleExpiresAt, session.absoluteExpiresAt]) if (!Number.isFinite(value)) throw new Error('invalid browser session timestamp')
  return session
}
