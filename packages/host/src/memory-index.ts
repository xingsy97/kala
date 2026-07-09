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

export type MemoryIndex = {
  generatedAt: string
  entries: readonly MemoryIndexEntry[]
  warnings: readonly string[]
}

export type BuildMemoryIndexInput = {
  rootDir: string
  workspaceRoot?: string
  includeGlobal?: boolean
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
  const index: MemoryIndex = {
    generatedAt: new Date().toISOString(),
    entries,
    warnings,
  }
  await mkdir(input.rootDir, { recursive: true })
  const indexPath = join(input.rootDir, 'memory-index.json')
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return { index, indexPath }
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
