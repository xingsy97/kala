export type PublicUrlPattern = {
  readonly protocol: 'http:' | 'https:'
  readonly hostname: string
  readonly port: number
  readonly wildcardHostname: boolean
}

export type PublicAccessDecision =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly status: 400 | 403; readonly error: 'INVALID_HOST' | 'HOST_NOT_ALLOWED' | 'ORIGIN_NOT_ALLOWED' }

export type PublicListener = {
  readonly host: string
  readonly port: number
}

export function parsePublicListeners(raw: string): readonly PublicListener[] {
  const entries = raw.split(',').map((value) => value.trim()).filter(Boolean)
  if (entries.length === 0) throw new Error('KALA_PUBLIC_LISTEN must contain at least one address')
  const listeners = entries.map(parsePublicListener)
  const identities = listeners.map((listener) => `${listener.host}:${listener.port}`)
  if (new Set(identities).size !== identities.length) throw new Error('KALA_PUBLIC_LISTEN must not contain duplicate addresses')
  return listeners
}

export function parsePublicUrls(raw: string): readonly PublicUrlPattern[] {
  const entries = raw.split(',').map((value) => value.trim()).filter(Boolean)
  if (entries.length === 0) throw new Error('KALA_PUBLIC_URLS must contain at least one URL')
  const patterns = entries.map(parsePublicUrl)
  const identities = patterns.map((pattern) => `${pattern.protocol}//${pattern.hostname}:${pattern.port}`)
  if (new Set(identities).size !== identities.length) throw new Error('KALA_PUBLIC_URLS must not contain duplicate URLs')
  return patterns
}

export function validatePublicRequest(
  patterns: readonly PublicUrlPattern[],
  hostHeader: string | undefined,
  originHeader?: string,
): PublicAccessDecision {
  const authority = parseAuthority(hostHeader)
  if (!authority) return { ok: false, status: 400, error: 'INVALID_HOST' }
  const candidates = patterns
    .filter((pattern) => hostMatches(pattern, authority))
    .sort((left, right) => Number(left.wildcardHostname) - Number(right.wildcardHostname))
  if (candidates.length === 0) return { ok: false, status: 400, error: 'HOST_NOT_ALLOWED' }

  if (originHeader !== undefined) {
    const origin = parseOrigin(originHeader)
    if (!origin) return { ok: false, status: 403, error: 'ORIGIN_NOT_ALLOWED' }
    const match = candidates.find((pattern) => origin === resolvedOrigin(pattern, authority.hostname))
    return match
      ? { ok: true, origin }
      : { ok: false, status: 403, error: 'ORIGIN_NOT_ALLOWED' }
  }

  return { ok: true, origin: resolvedOrigin(candidates[0]!, authority.hostname) }
}

function parsePublicUrl(value: string): PublicUrlPattern {
  const wildcardPrefix = /^(https?):\/\/\*/u.exec(value)
  const parseable = wildcardPrefix ? value.replace(`${wildcardPrefix[1]}://*`, `${wildcardPrefix[1]}://kala-wildcard.invalid`) : value
  let url: URL
  try {
    url = new URL(parseable)
  } catch {
    throw new Error(`KALA_PUBLIC_URLS contains an invalid URL: ${value}`)
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error(`KALA_PUBLIC_URLS contains an invalid public origin: ${value}`)
  }
  const wildcardHostname = wildcardPrefix !== null
  if (wildcardHostname && !/^https?:\/\/\*(?::[0-9]+)?$/u.test(value)) {
    throw new Error(`KALA_PUBLIC_URLS contains an invalid wildcard URL: ${value}`)
  }
  const port = effectivePort(url.protocol, url.port)
  return {
    protocol: url.protocol,
    hostname: wildcardHostname ? '*' : normalizeHostname(url.hostname),
    port,
    wildcardHostname,
  }
}

function parsePublicListener(value: string): PublicListener {
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/u.exec(value)
  if (ipv6) {
    let host: string
    try {
      host = normalizeHostname(new URL(`http://[${ipv6[1]}]`).hostname)
    } catch {
      throw new Error(`KALA_PUBLIC_LISTEN contains an invalid IPv6 address: ${value}`)
    }
    if (!host.includes(':')) throw new Error(`KALA_PUBLIC_LISTEN contains an invalid IPv6 address: ${value}`)
    return { host, port: listenerPort(ipv6[2]!, value) }
  }
  const ipv4 = /^([^:]+):(\d+)$/u.exec(value)
  if (!ipv4 || !validIpv4(ipv4[1]!)) throw new Error(`KALA_PUBLIC_LISTEN must use literal IP addresses with ports: ${value}`)
  return { host: ipv4[1]!, port: listenerPort(ipv4[2]!, value) }
}

function parseAuthority(value: string | undefined): { hostname: string; explicitPort?: number } | undefined {
  if (!value || /[/\\@?#\s]/u.test(value)) return undefined
  try {
    const url = new URL(`http://${value}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    const explicitPort = explicitAuthorityPort(value)
    return {
      hostname: normalizeHostname(url.hostname),
      ...(explicitPort !== undefined ? { explicitPort } : {}),
    }
  } catch {
    return undefined
  }
}

function parseOrigin(value: string): string | undefined {
  if (value === 'null') return undefined
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
    ) return undefined
    return formatOrigin(url.protocol, normalizeHostname(url.hostname), effectivePort(url.protocol, url.port))
  } catch {
    return undefined
  }
}

function hostMatches(pattern: PublicUrlPattern, authority: { hostname: string; explicitPort?: number }): boolean {
  if (!pattern.wildcardHostname && pattern.hostname !== authority.hostname) return false
  return (authority.explicitPort ?? defaultPort(pattern.protocol)) === pattern.port
}

function resolvedOrigin(pattern: PublicUrlPattern, hostname: string): string {
  return formatOrigin(pattern.protocol, pattern.wildcardHostname ? hostname : pattern.hostname, pattern.port)
}

function formatOrigin(protocol: 'http:' | 'https:', hostname: string, port: number): string {
  const authority = hostname.includes(':') ? `[${hostname.replace(/^\[|\]$/gu, '')}]` : hostname
  return `${protocol}//${authority}${port === defaultPort(protocol) ? '' : `:${port}`}`
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase()
  if (normalized.startsWith('[') && normalized.endsWith(']')) return normalized.slice(1, -1)
  return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized
}

function effectivePort(protocol: 'http:' | 'https:', value: string): number {
  const port = value === '' ? defaultPort(protocol) : Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('public URL port must be between 1 and 65535')
  return port
}

function defaultPort(protocol: 'http:' | 'https:'): number {
  return protocol === 'https:' ? 443 : 80
}

function explicitAuthorityPort(authority: string): number | undefined {
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\]:(\d+)$/u.exec(authority)
    : /:(\d+)$/u.exec(authority)
  if (!match) return undefined
  const port = Number(match[1])
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined
}

function listenerPort(value: string, input: string): number {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`KALA_PUBLIC_LISTEN contains an invalid port: ${input}`)
  }
  return port
}

function validIpv4(value: string): boolean {
  const octets = value.split('.')
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255)
}
