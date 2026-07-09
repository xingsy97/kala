import { describe, expect, it } from 'vitest'

import {
  authenticateExecutorToken,
  validateExecutorAnnouncement,
  authSettings,
} from './auth-control.js'
import { ExecutorIdentityStore } from './store/executor-identity.js'

describe('auth-control', () => {
  it('binds executor token scope to one workspace id', () => {
    const identity = authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', token: 'secret' },
      { executorTokens: [{ token: 'secret', workspaceId: 'ws-1', label: 'prod' }] },
    )
    expect(identity).toMatchObject({ accepted: true, workspaceId: 'ws-1', label: 'prod' })
    expect(validateExecutorAnnouncement(identity, 'ws-1')).toEqual({ ok: true })
    expect(validateExecutorAnnouncement(identity, 'ws-2')).toEqual({ ok: false, reason: 'workspace_identity_mismatch' })
  })

  it('rejects unknown executor tokens when scopes are configured', () => {
    const identity = authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', token: 'wrong' },
      { executorTokens: [{ token: 'secret', workspaceId: 'ws-1' }] },
    )
    expect(identity).toEqual({ accepted: false, reason: 'auth_failed' })
  })

  it('requires invite or known token when a persistent executor identity store is configured', () => {
    const store = new ExecutorIdentityStore('/tmp/not-used.json')

    expect(authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0' },
      { executorIdentityStore: store },
    )).toEqual({ accepted: false, reason: 'auth_failed' })

    expect(authenticateExecutorToken(
      { role: 'executor', clientVersion: '0.1.0', invite: 'ak_invite_test' },
      { executorIdentityStore: store },
    )).toEqual({ accepted: true, inviteToken: 'ak_invite_test' })
  })

  it('summarizes auth settings without secrets', () => {
    expect(authSettings({
      sharedToken: 'hidden',
      github: {
        required: true,
        clientId: 'id',
        clientSecret: 'secret',
        callbackUrl: 'https://host/auth/github/callback',
        sessionSecret: 'cookie-secret',
        usernameWhitelist: ['alice'],
      },
      executorTokens: [{ token: 'exec-hidden', workspaceId: 'ws-1' }],
    })).toEqual({
      dashboardAuthRequired: true,
      githubOAuth: {
        required: true,
        configured: true,
        usernameWhitelistEnabled: true,
        usernameWhitelist: ['alice'],
      },
      executorIdentity: {
        tokenScoped: true,
        tokenCount: 1,
      },
    })
  })
})
