import { readFile } from 'node:fs/promises'

import { MemoryEnterpriseSsoResolver, type EnterpriseSsoConnection } from './enterprise-sso.js'

export async function loadEnterpriseSsoResolver(path: string): Promise<MemoryEnterpriseSsoResolver> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { connections?: unknown }).connections)) {
    throw new Error('enterprise SSO config must contain a connections array')
  }
  const ids = new Set<string>()
  const connections = (raw as { connections: unknown[] }).connections.map((value): EnterpriseSsoConnection => {
    if (!value || typeof value !== 'object') throw new Error('enterprise SSO connection must be an object')
    const item = value as Record<string, unknown>
    const id = requiredOpaque(item.id, 'connection id')
    const providerId = requiredOpaque(item.providerId, 'provider id')
    if (ids.has(id)) throw new Error(`duplicate enterprise SSO connection: ${id}`)
    ids.add(id)
    const loginHint = typeof item.loginHint === 'string' && item.loginHint.trim() ? item.loginHint.trim() : undefined
    return { id, providerId, ...(loginHint ? { loginHint } : {}) }
  })
  return new MemoryEnterpriseSsoResolver(connections)
}

function requiredOpaque(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) throw new Error(`invalid enterprise SSO ${label}`)
  return value
}
