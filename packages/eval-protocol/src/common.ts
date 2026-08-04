import { z } from 'zod'

export const ProtocolVersionSchema = z.literal(1)
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const
export const NonEmptyStringSchema = z.string().trim().min(1)
export const IdentifierSchema = NonEmptyStringSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase SHA-256 digest')
export const IsoDateTimeSchema = z.string().datetime()

export const RelativeArtifactPathSchema = NonEmptyStringSchema.superRefine((path, ctx) => {
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(path)) {
    ctx.addIssue({ code: 'custom', message: 'artifact path must be relative' })
  }
  if (path.split(/[\\/]/u).some((part) => part === '..')) {
    ctx.addIssue({ code: 'custom', message: 'artifact path must not traverse parent directories' })
  }
})

export const CredentialReferenceSchema = z.object({
  referenceId: IdentifierSchema,
  provider: NonEmptyStringSchema,
  scope: z.array(NonEmptyStringSchema).default([]),
}).strict()

export type CredentialReference = z.infer<typeof CredentialReferenceSchema>

export function negotiateProtocolVersion(left: readonly number[], right: readonly number[]): number {
  const leftVersions = new Set(left.filter((version) => Number.isSafeInteger(version) && version > 0))
  const compatible = [...new Set(right.filter((version) => Number.isSafeInteger(version) && version > 0))].filter((version) => leftVersions.has(version)).sort((a, b) => b - a)
  const selected = compatible[0]
  if (selected === undefined) throw new Error('no compatible evaluation protocol version')
  return selected
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonicalize(source[key])]))
  }
  return value
}

export function findPlaintextCredentialPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findPlaintextCredentialPaths(entry, path + '[' + index + ']'))
  }
  if (!value || typeof value !== 'object') return []
  const findings: string[] = []
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const current = path + '.' + key
    if (/(?:api[_-]?key|access[_-]?token|password|client[_-]?secret|credential|secret)$/iu.test(key)
      && !/(?:ref|reference|referenceId)$/iu.test(key)
      && typeof entry === 'string'
      && entry.trim().length > 0) findings.push(current)
    findings.push(...findPlaintextCredentialPaths(entry, current))
  }
  return findings
}

export type ProtocolMigration<T> = {
  from: number
  to: number
  migrate(value: unknown): unknown
  target: { parse(value: unknown): T }
}

export function migrateCanonicalProtocol<T>(input: unknown, targetVersion: number, migrations: readonly ProtocolMigration<T>[]): T {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('canonical protocol value must be an object')
  const sourceVersion = (input as { schemaVersion?: unknown }).schemaVersion
  if (!Number.isSafeInteger(sourceVersion) || (sourceVersion as number) < 1) throw new Error('canonical protocol value has no supported schemaVersion')
  let version = sourceVersion as number
  let value: unknown = input
  while (version < targetVersion) {
    const candidates = migrations.filter((migration) => migration.from === version && migration.to > version && migration.to <= targetVersion).sort((left, right) => left.to - right.to)
    const migration = candidates[0]
    if (!migration) throw new Error('no canonical protocol migration path from version ' + String(version) + ' to ' + String(targetVersion))
    value = migration.migrate(value)
    version = migration.to
  }
  if (version !== targetVersion) throw new Error('canonical protocol value is newer than requested target version')
  const target = migrations.find((migration) => migration.to === targetVersion)?.target
  if (!target) throw new Error('canonical protocol target schema is not registered for version ' + String(targetVersion))
  return target.parse(value)
}
