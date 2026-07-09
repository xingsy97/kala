import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type StoredExecutorIdentity = {
  tokenHash: string
  workspaceId: string
  label?: string
  createdAt: string
  lastSeenAt?: string
}

type FileShape = {
  schemaVersion: 1
  executors: StoredExecutorIdentity[]
  invites?: StoredExecutorInvite[]
}

export type ExecutorInvite = {
  inviteToken: string
  expiresAt: string
}

type InviteRecord = ExecutorInvite & {
  createdAt: string
  used: boolean
}

type StoredExecutorInvite = Omit<InviteRecord, 'inviteToken'> & {
  inviteHash: string
}

export class ExecutorIdentityStore {
  private identities: StoredExecutorIdentity[] = []
  private invites = new Map<string, InviteRecord>()

  constructor(private readonly path: string) {}

  load(): void {
    if (!existsSync(this.path)) return
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as FileShape
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.executors)) return
    this.identities = parsed.executors.filter((entry) => typeof entry.tokenHash === 'string' && typeof entry.workspaceId === 'string')
    this.invites.clear()
    const now = Date.now()
    for (const invite of parsed.invites ?? []) {
      if (typeof invite.inviteHash !== 'string' || typeof invite.expiresAt !== 'string') continue
      if (Date.parse(invite.expiresAt) < now) continue
      this.invites.set(invite.inviteHash, {
        inviteToken: invite.inviteHash,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        used: invite.used === true,
      })
    }
  }

  snapshot(): readonly StoredExecutorIdentity[] {
    return [...this.identities]
  }

  createInvite(ttlMs = 10 * 60 * 1000): ExecutorInvite {
    const inviteToken = `ak_invite_${randomBytes(24).toString('base64url')}`
    const now = Date.now()
    const invite = {
      inviteToken,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      used: false,
    }
    this.invites.set(hashToken(inviteToken), { ...invite, inviteToken: hashToken(inviteToken) })
    this.save()
    return { inviteToken, expiresAt: invite.expiresAt }
  }

  consumeInvite(inviteToken: string | undefined, workspaceId: string, label?: string): { ok: true; token: string } | { ok: false; reason: string } {
    if (!inviteToken) return { ok: false, reason: 'missing_invite' }
    const invite = this.invites.get(hashToken(inviteToken))
    if (!invite || invite.used) return { ok: false, reason: 'invalid_invite' }
    if (Date.parse(invite.expiresAt) < Date.now()) return { ok: false, reason: 'invite_expired' }
    invite.used = true
    const token = `ak_exec_${randomBytes(32).toString('base64url')}`
    const identity: StoredExecutorIdentity = {
      tokenHash: hashToken(token),
      workspaceId,
      ...(label ? { label } : {}),
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }
    this.identities = this.identities.filter((entry) => entry.workspaceId !== workspaceId)
    this.identities.push(identity)
    this.save()
    return { ok: true, token }
  }

  resolveToken(token: string | undefined): StoredExecutorIdentity | undefined {
    if (!token) return undefined
    const tokenHash = hashToken(token)
    return this.identities.find((entry) => entry.tokenHash === tokenHash)
  }

  markSeen(token: string | undefined): void {
    const entry = this.resolveToken(token)
    if (!entry) return
    entry.lastSeenAt = new Date().toISOString()
    this.save()
  }

  revokeWorkspace(workspaceId: string): boolean {
    const before = this.identities.length
    this.identities = this.identities.filter((entry) => entry.workspaceId !== workspaceId)
    if (this.identities.length === before) return false
    this.save()
    return true
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const now = Date.now()
    const invites: StoredExecutorInvite[] = [...this.invites.values()]
      .filter((invite) => Date.parse(invite.expiresAt) >= now && !invite.used)
      .map((invite) => ({
        inviteHash: invite.inviteToken,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        used: invite.used,
      }))
    const body: FileShape = { schemaVersion: 1, executors: this.identities, invites }
    writeFileSync(this.path, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}

export function hashToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`
}
