import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  BearerAuthConfigSchema, type AuthorizationScope, type BearerAuthConfig, type Principal,
  principalHasScope, validatePrincipalScopes,
} from '@agent-kernel/eval-protocol'

export interface Authenticator {
  authenticate(authorization: string | undefined): Principal | undefined
}

export class AuthorizationError extends Error {
  constructor(readonly status: 401 | 403, readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN', message: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

export class BearerTokenAuthenticator implements Authenticator {
  private readonly entries: ReadonlyArray<{ token: Buffer; principal: Principal }>

  constructor(config: BearerAuthConfig) {
    const parsed = BearerAuthConfigSchema.parse(config)
    const seen = new Set<string>()
    this.entries = parsed.keys.map(({ key, principal }) => {
      if (seen.has(key)) throw new Error('duplicate bearer key')
      seen.add(key)
      return { token: Buffer.from(key), principal: validatePrincipalScopes(principal) }
    })
  }

  authenticate(authorization: string | undefined): Principal | undefined {
    const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? '')
    if (!match) return undefined
    const candidate = Buffer.from(match[1]!)
    return this.entries.find(({ token }) => token.length === candidate.length && timingSafeEqual(token, candidate))?.principal
  }
}

export async function loadBearerAuthConfig(path: string): Promise<BearerAuthConfig> {
  return BearerAuthConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export function requirePrincipal(authenticator: Authenticator, authorization: string | undefined, scope: AuthorizationScope): Principal {
  const principal = requireAuthenticatedPrincipal(authenticator, authorization)
  if (!principalHasScope(principal, scope)) throw new AuthorizationError(403, 'FORBIDDEN', 'principal lacks required scope: ' + scope)
  return principal
}

export function requireAuthenticatedPrincipal(authenticator: Authenticator, authorization: string | undefined): Principal {
  const principal = authenticator.authenticate(authorization)
  if (!principal) throw new AuthorizationError(401, 'UNAUTHENTICATED', 'valid Bearer authentication is required')
  return principal
}

export function bindServicePrincipal(principal: Principal, role: 'worker' | 'analyzer', serviceId: string): void {
  if (principal.kind !== 'service' || principal.role !== role || principal.serviceId !== serviceId) {
    throw new AuthorizationError(403, 'FORBIDDEN', role + ' service identity does not match request authority')
  }
}
