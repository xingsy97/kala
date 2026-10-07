import { describe, expect, it } from 'vitest'

import { selectVerifiedEmail } from './oidc-client.js'

describe('OIDC verified email claims', () => {
  it('keeps email and verification proof from the same trusted claim source', () => {
    expect(selectVerifiedEmail({ email: 'token@example.test', email_verified: true }, {
      email: 'userinfo@example.test',
      email_verified: false,
    })).toEqual({ email: 'userinfo@example.test', verified: false })
    expect(selectVerifiedEmail({ email: 'token@example.test', email_verified: true }, undefined))
      .toEqual({ email: 'token@example.test', verified: true })
  })

  it('fails closed when the provider omits or mis-types email_verified', () => {
    expect(selectVerifiedEmail({ email: 'user@example.test' }, undefined))
      .toEqual({ email: 'user@example.test', verified: false })
    expect(selectVerifiedEmail({ email: 'user@example.test', email_verified: 'true' }, undefined))
      .toEqual({ email: 'user@example.test', verified: false })
    expect(selectVerifiedEmail({ email_verified: true }, undefined)).toBeUndefined()
  })
})
