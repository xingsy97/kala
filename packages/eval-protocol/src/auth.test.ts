import { describe, expect, it } from 'vitest'

import { PrincipalSchema, ROLE_SCOPE_MATRIX, principalHasScope, validatePrincipalScopes } from './auth.js'

describe('evaluation identity contracts', () => {
  it('requires explicit service identities for Worker and Analyzer roles', () => {
    expect(() => PrincipalSchema.parse({ schemaVersion: 1, principalId: 'worker-one', kind: 'user', role: 'worker', scopes: ['worker:execute'] })).toThrow()
    expect(PrincipalSchema.parse({ schemaVersion: 1, principalId: 'worker-principal', kind: 'service', role: 'worker', serviceId: 'worker-one', scopes: ['worker:execute'] })).toMatchObject({ serviceId: 'worker-one' })
  })

  it('enforces the role scope matrix and admin implication', () => {
    expect(ROLE_SCOPE_MATRIX.viewer).not.toContain('evaluation:write')
    expect(() => validatePrincipalScopes({ schemaVersion: 1, principalId: 'viewer-one', kind: 'user', role: 'viewer', scopes: ['evaluation:write'] })).toThrow('not allowed')
    expect(principalHasScope({ schemaVersion: 1, principalId: 'operator-one', kind: 'user', role: 'operator', scopes: ['admin'] }, 'governance:write')).toBe(true)
  })
})
