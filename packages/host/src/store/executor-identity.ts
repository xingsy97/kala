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
  id: string
  inviteToken: string
  label?: string
  workspaceId?: string
  createdAt: string
  lastUsedAt?: string
}

export type ExecutorInviteSummary = Omit<ExecutorInvite, 'inviteToken'> & {
  revoked: boolean
}

type InviteRecord = ExecutorInviteSummary & {
  inviteHash: string
}

type StoredExecutorInvite = InviteRecord & {
  expiresAt?: string
  used?: boolean
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
    for (const invite of parsed.invites ?? []) {
      if (typeof invite.inviteHash !== 'string' || typeof invite.id !== 'string') continue
      const record: InviteRecord = {
        id: invite.id,
        inviteHash: invite.inviteHash,
        createdAt: typeof invite.createdAt === 'string' ? invite.createdAt : new Date().toISOString(),
        revoked: invite.revoked === true,
        ...(typeof invite.label === 'string' && invite.label.trim().length > 0 ? { label: invite.label } : {}),
        ...(typeof invite.workspaceId === 'string' && invite.workspaceId.trim().length > 0 ? { workspaceId: invite.workspaceId } : {}),
        ...(typeof invite.lastUsedAt === 'string' ? { lastUsedAt: invite.lastUsedAt } : {}),
      }
      this.invites.set(record.id, record)
    }
  }

  snapshot(): readonly StoredExecutorIdentity[] {
    return [...this.identities]
  }

  inviteSnapshot(): readonly ExecutorInviteSummary[] {
    return [...this.invites.values()].map(({ inviteHash: _inviteHash, ...entry }) => entry)
  }

  createInvite(input: { label?: string; workspaceId?: string } = {}): ExecutorInvite {
    const id = `inv_${randomBytes(12).toString('base64url')}`
    const inviteToken = `ak_invite_${randomBytes(24).toString('base64url')}`
    const invite: InviteRecord = {
      id,
      inviteHash: hashToken(inviteToken),
      createdAt: new Date().toISOString(),
      revoked: false,
      ...(cleanString(input.label) ? { label: cleanString(input.label) } : {}),
      ...(cleanString(input.workspaceId) ? { workspaceId: cleanString(input.workspaceId) } : {}),
    }
    this.invites.set(id, invite)
    this.save()
    return { id, inviteToken, ...(invite.label ? { label: invite.label } : {}), ...(invite.workspaceId ? { workspaceId: invite.workspaceId } : {}), createdAt: invite.createdAt }
  }

  consumeInvite(inviteToken: string | undefined, workspaceId: string, label?: string): { ok: true; token: string } | { ok: false; reason: string } {
    if (!inviteToken) return { ok: false, reason: 'missing_invite' }
    const invite = this.findInviteByToken(inviteToken)
    if (!invite || invite.revoked) return { ok: false, reason: 'invalid_invite' }
    if (invite.workspaceId && invite.workspaceId !== workspaceId) return { ok: false, reason: 'workspace_identity_mismatch' }
    invite.workspaceId = workspaceId
    invite.lastUsedAt = new Date().toISOString()
    if (!invite.label && label) invite.label = label
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

  updateInvite(id: string, input: { label?: string; workspaceId?: string | null }): ExecutorInviteSummary | undefined {
    const invite = this.invites.get(id)
    if (!invite) return undefined
    if (input.label !== undefined) {
      const label = cleanString(input.label)
      if (label) invite.label = label
      else delete invite.label
    }
    if (input.workspaceId !== undefined) {
      const workspaceId = input.workspaceId === null ? undefined : cleanString(input.workspaceId)
      if (workspaceId) invite.workspaceId = workspaceId
      else delete invite.workspaceId
    }
    this.save()
    const { inviteHash: _inviteHash, ...summary } = invite
    return summary
  }

  revokeInvite(id: string): boolean {
    const invite = this.invites.get(id)
    if (!invite || invite.revoked) return false
    if (invite.workspaceId) this.identities = this.identities.filter((entry) => entry.workspaceId !== invite.workspaceId)
    invite.revoked = true
    this.save()
    return true
  }

  regenerateInvite(id: string): ExecutorInvite | undefined {
    const invite = this.invites.get(id)
    if (!invite) return undefined
    const inviteToken = `ak_invite_${randomBytes(24).toString('base64url')}`
    if (invite.workspaceId) this.identities = this.identities.filter((entry) => entry.workspaceId !== invite.workspaceId)
    invite.inviteHash = hashToken(inviteToken)
    invite.revoked = false
    delete invite.workspaceId
    delete invite.lastUsedAt
    this.save()
    return {
      id: invite.id,
      inviteToken,
      ...(invite.label ? { label: invite.label } : {}),
      createdAt: invite.createdAt,
    }
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
    const invites: StoredExecutorInvite[] = [...this.invites.values()].map((invite) => ({ ...invite }))
    const body: FileShape = { schemaVersion: 1, executors: this.identities, invites }
    writeFileSync(this.path, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  private findInviteByToken(inviteToken: string): InviteRecord | undefined {
    const inviteHash = hashToken(inviteToken)
    return [...this.invites.values()].find((entry) => entry.inviteHash === inviteHash)
  }
}

export function hashToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
