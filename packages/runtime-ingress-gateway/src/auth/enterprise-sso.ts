import type { AuthenticatedIdentity } from '../assignments/store.js'

export type EnterpriseSsoConnection = {
  readonly id: string
  readonly providerId: string
  readonly loginHint?: string
}

/** Resolves opaque product SSO selectors; provider identifiers never come directly from browser input. */
export interface EnterpriseSsoResolver {
  resolve(selector: string): Promise<EnterpriseSsoConnection | undefined>
  authorize(connection: EnterpriseSsoConnection, identity: AuthenticatedIdentity): Promise<boolean>
}

export class MemoryEnterpriseSsoResolver implements EnterpriseSsoResolver {
  private readonly connections = new Map<string, EnterpriseSsoConnection>()
  constructor(connections: readonly EnterpriseSsoConnection[] = []) {
    for (const connection of connections) this.connections.set(connection.id, connection)
  }
  async resolve(selector: string): Promise<EnterpriseSsoConnection | undefined> { return this.connections.get(selector) }
  async authorize(connection: EnterpriseSsoConnection, identity: AuthenticatedIdentity): Promise<boolean> {
    return identity.upstreamProviderId === connection.providerId
  }
}
