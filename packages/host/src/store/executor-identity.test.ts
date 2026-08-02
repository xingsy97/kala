import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutorIdentityStore, hashToken } from './executor-identity.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function path() { const dir = mkdtempSync(join(tmpdir(), 'executor-identity-')); dirs.push(dir); return join(dir, 'store.json') }

describe('ExecutorIdentityStore invite expiry', () => {
  it('pairs once and never exposes or replays the credential', () => {
    const file = path(), store = new ExecutorIdentityStore(file)
    const pairing = store.createPairing({ workspaceId: 'paired', label: 'laptop' })
    expect(store.pairingSnapshot()[0]).not.toHaveProperty('claimSecret')
    expect(store.pairingSnapshot()[0]).not.toHaveProperty('token')
    expect(store.decidePairing(pairing.id, true)?.status).toBe('approved')
    expect(store.claimPairing(pairing.id, pairing.claimSecret)?.token).toMatch(/^ak_exec_/u)
    expect(store.claimPairing(pairing.id, pairing.claimSecret)).toEqual({ status: 'claimed' })
  })

  it('creates bounded invites and preserves expiry across reload', () => {
    const file = path(), store = new ExecutorIdentityStore(file)
    const invite = store.createInvite({ label: 'phone' })
    expect(Date.parse(invite.expiresAt)).toBeGreaterThan(Date.now())
    const loaded = new ExecutorIdentityStore(file); loaded.load()
    expect(loaded.inviteSnapshot()[0]?.expiresAt).toBe(invite.expiresAt)
    expect(readFileSync(file, 'utf8')).not.toContain(invite.inviteToken)
  })

  it('rotates and revokes long-lived credentials without accepting old tokens', () => {
    const file = path(), store = new ExecutorIdentityStore(file)
    const first = store.provisionWorkspace('workspace', 'Executor')
    const second = store.rotateWorkspaceCredential('workspace')
    expect(store.resolveToken(first)).toBeUndefined()
    expect(store.resolveToken(second)?.credentialVersion).toBe(2)
    expect(store.revokeWorkspace('workspace')).toBe(true)
    expect(store.resolveToken(second)).toBeUndefined()
  })

  it('rejects expired invites and regeneration issues a new expiry', () => {
    const file = path(), token = 'ak_invite_expired'
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, executors: [], invites: [{ id: 'inv_old', inviteHash: hashToken(token), createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z', revoked: false }] }))
    const store = new ExecutorIdentityStore(file); store.load()
    expect(store.consumeInvite(token, 'workspace')).toEqual({ ok: false, reason: 'invite_expired' })
    const regenerated = store.regenerateInvite('inv_old')!
    expect(Date.parse(regenerated.expiresAt)).toBeGreaterThan(Date.now())
    expect(store.consumeInvite(regenerated.inviteToken, 'workspace').ok).toBe(true)
  })
})
