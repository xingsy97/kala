import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type MemoryIndexEntry = {
  scope: 'workspace' | 'global'
  key: string
  path: string
  bytes: number
  status: 'active' | 'tombstoned'
  name?: string
  description?: string
  type?: string
  source?: string
  confidence?: number
  generatedAt?: string
  sessionId?: string
  deletedAt?: string
  archivedPath?: string
}

export type MemoryStaleWarning = {
  scope: MemoryIndexEntry['scope']
  key: string
  path: string
  generatedAt: string
  ageDays: number
  reasonCode: 'stale_memory'
}

export type MemoryConflictWarning = {
  reasonCode: 'duplicate_key_across_scopes' | 'duplicate_name'
  key?: string
  name?: string
  entries: readonly {
    scope: MemoryIndexEntry['scope']
    key: string
    path: string
  }[]
}

export type MemoryIndex = {
  generatedAt: string
  entries: readonly MemoryIndexEntry[]
  warnings: readonly string[]
  staleWarnings: readonly MemoryStaleWarning[]
  conflictWarnings: readonly MemoryConflictWarning[]
}

export type BuildMemoryIndexInput = {
  rootDir: string
  workspaceRoot?: string
  includeGlobal?: boolean
  /**
   * Entries with a `generatedAt` timestamp older than this many days are
   * flagged as stale. Defaults to 90. Entries without `generatedAt` are never
   * flagged because there is no evidence of freshness one way or the other.
   */
  staleAfterDays?: number
  /** Override current time for deterministic tests. */
  now?: () => Date
}

export async function buildMemoryIndex(
  input: BuildMemoryIndexInput,
): Promise<{ index: MemoryIndex; indexPath: string }> {
  const warnings: string[] = []
  const entries: MemoryIndexEntry[] = []
  if (input.workspaceRoot) {
    entries.push(...await readMemoryDir('workspace', join(input.workspaceRoot, '.agent-kernel', 'memory'), warnings))
  }
  if (input.includeGlobal) {
    entries.push(...await readMemoryDir('global', join(homedir(), '.agent-kernel', 'memory'), warnings))
  }
  entries.sort((a, b) => `${a.scope}:${a.key}`.localeCompare(`${b.scope}:${b.key}`))
  const now = input.now ? input.now() : new Date()
  const staleAfterDays = input.staleAfterDays ?? 90
  const staleWarnings = detectStaleMemories(entries, now, staleAfterDays)
  const conflictWarnings = detectConflictingMemories(entries)
  const index: MemoryIndex = {
    generatedAt: now.toISOString(),
    entries,
    warnings,
    staleWarnings,
    conflictWarnings,
  }
  await mkdir(input.rootDir, { recursive: true })
  const indexPath = join(input.rootDir, 'memory-index.json')
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return { index, indexPath }
}

function detectStaleMemories(
  entries: readonly MemoryIndexEntry[],
  now: Date,
  staleAfterDays: number,
): MemoryStaleWarning[] {
  const out: MemoryStaleWarning[] = []
  const nowMs = now.getTime()
  const thresholdMs = staleAfterDays * 24 * 60 * 60 * 1000
  for (const entry of entries) {
    if (entry.status !== 'active') continue
    if (!entry.generatedAt) continue
    const t = Date.parse(entry.generatedAt)
    if (!Number.isFinite(t)) continue
    const ageMs = nowMs - t
    if (ageMs < thresholdMs) continue
    out.push({
      scope: entry.scope,
      key: entry.key,
      path: entry.path,
      generatedAt: entry.generatedAt,
      ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      reasonCode: 'stale_memory',
    })
  }
  return out
}

function detectConflictingMemories(
  entries: readonly MemoryIndexEntry[],
): MemoryConflictWarning[] {
  const active = entries.filter((entry) => entry.status === 'active')
  const out: MemoryConflictWarning[] = []
  const byKey = new Map<string, MemoryIndexEntry[]>()
  for (const entry of active) {
    const bucket = byKey.get(entry.key) ?? []
    bucket.push(entry)
    byKey.set(entry.key, bucket)
  }
  for (const [key, group] of byKey) {
    if (group.length < 2) continue
    const scopes = new Set(group.map((entry) => entry.scope))
    if (scopes.size < 2) continue
    out.push({
      reasonCode: 'duplicate_key_across_scopes',
      key,
      entries: group.map((entry) => ({ scope: entry.scope, key: entry.key, path: entry.path })),
    })
  }
  const byName = new Map<string, MemoryIndexEntry[]>()
  for (const entry of active) {
    if (!entry.name) continue
    const bucket = byName.get(entry.name) ?? []
    bucket.push(entry)
    byName.set(entry.name, bucket)
  }
  for (const [name, group] of byName) {
    if (group.length < 2) continue
    const distinct = new Set(group.map((entry) => `${entry.scope}:${entry.key}`))
    if (distinct.size < 2) continue
    out.push({
      reasonCode: 'duplicate_name',
      name,
      entries: group.map((entry) => ({ scope: entry.scope, key: entry.key, path: entry.path })),
    })
  }
  return out
}

async function readMemoryDir(
  scope: MemoryIndexEntry['scope'],
  dir: string,
  warnings: string[],
): Promise<MemoryIndexEntry[]> {
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort()
  const out: MemoryIndexEntry[] = []
  for (const file of files) {
    const path = join(dir, file)
    try {
      const content = await readFile(path, 'utf8')
      const frontmatter = parseFrontmatter(content)
      const confidenceRaw = frontmatter.get('confidence')
      const confidence = confidenceRaw === undefined ? undefined : Number(confidenceRaw)
      out.push({
        scope,
        key: file.replace(/\.md$/, ''),
        path,
        bytes: Buffer.byteLength(content, 'utf8'),
        status: 'active',
        ...(frontmatter.get('name') ? { name: frontmatter.get('name') } : {}),
        ...(frontmatter.get('description') ? { description: frontmatter.get('description') } : {}),
        ...(frontmatter.get('type') ? { type: frontmatter.get('type') } : {}),
        ...(frontmatter.get('source') ? { source: frontmatter.get('source') } : {}),
        ...(Number.isFinite(confidence) ? { confidence } : {}),
        ...(frontmatter.get('generatedAt') ? { generatedAt: frontmatter.get('generatedAt') } : {}),
        ...(frontmatter.get('sessionId') ? { sessionId: frontmatter.get('sessionId') } : {}),
      })
    } catch (err) {
      warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  out.push(...await readTombstoneDir(scope, join(dir, '.tombstones'), warnings))
  return out
}

async function readTombstoneDir(
  scope: MemoryIndexEntry['scope'],
  dir: string,
  warnings: string[],
): Promise<MemoryIndexEntry[]> {
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort()
  const out: MemoryIndexEntry[] = []
  for (const file of files) {
    const path = join(dir, file)
    try {
      const content = await readFile(path, 'utf8')
      const body = JSON.parse(content) as {
        key?: unknown
        deletedAt?: unknown
        archivedPath?: unknown
      }
      if (typeof body.key !== 'string' || body.key.length === 0) {
        throw new Error('tombstone key is missing')
      }
      out.push({
        scope,
        key: body.key,
        path,
        bytes: Buffer.byteLength(content, 'utf8'),
        status: 'tombstoned',
        ...(typeof body.deletedAt === 'string' ? { deletedAt: body.deletedAt } : {}),
        ...(typeof body.archivedPath === 'string' ? { archivedPath: body.archivedPath } : {}),
      })
    } catch (err) {
      warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}

function parseFrontmatter(content: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return out
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line?.trim() === '---') return out
    if (!line || line.trim().startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    out.set(match[1]!, unquote(match[2]!.trim()))
  }
  return out
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}
