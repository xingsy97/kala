export interface CredentialProvider {
  getToken(): string | undefined | Promise<string | undefined>
}

export type CredentialProviderLike = CredentialProvider | (() => string | undefined | Promise<string | undefined>)

export function staticBearerToken(token: string): CredentialProvider {
  const value = requiredToken(token)
  return { getToken: () => value }
}

export function environmentBearerToken(environment: Record<string, string | undefined>, name = 'AGENT_EVAL_TOKEN'): CredentialProvider {
  return { getToken: () => environment[name] === undefined ? undefined : requiredToken(environment[name]!) }
}

/** Reads on every request so an atomically replaced token file takes effect without a restart. */
export function rotatingBearerToken(readToken: () => string | Promise<string>): CredentialProvider {
  return { getToken: async () => requiredToken(await readToken()) }
}

export function resolveCredentialProvider(provider: CredentialProviderLike): () => Promise<string | undefined> {
  return async () => requiredOptionalToken(await (typeof provider === 'function' ? provider() : provider.getToken()))
}

function requiredOptionalToken(token: string | undefined): string | undefined {
  return token === undefined ? undefined : requiredToken(token)
}

function requiredToken(token: string): string {
  const value = token.trim()
  if (!value || /\s/u.test(value)) throw new Error('Bearer token must be non-empty and contain no whitespace')
  return value
}
