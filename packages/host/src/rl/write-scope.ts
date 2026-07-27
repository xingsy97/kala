import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { AgentRlTask } from '@agent-kernel/shared/enhancement'

export type FileSnapshot = { path: string; mtimeMs: number; sha256: string }
export type WriteScopeSnapshot = {
  files: FileSnapshot[]
  denyGlobs: string[]
  allowGlobs: string[]
}

const DEFAULT_TRANSIENT_IGNORE_GLOBS: readonly string[] = [
  '**/__pycache__/**',
  '**/*.pyc',
  '**/*.pyo',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  '**/.ruff_cache/**',
]

export async function snapshotWriteScope(workdir: string, task: AgentRlTask): Promise<WriteScopeSnapshot | null> {
  const ws = task.verifier.writeScope
  if (!ws) return null
  const files: FileSnapshot[] = []
  for await (const rel of walkFiles(workdir)) {
    if (matchesAny(rel, DEFAULT_TRANSIENT_IGNORE_GLOBS)) continue
    if (!matchesAny(rel, ws.denyGlobs)) continue
    const abs = join(workdir, rel)
    const st = await stat(abs)
    const bytes = await readFile(abs)
    files.push({ path: rel, mtimeMs: st.mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return { files, denyGlobs: [...ws.denyGlobs], allowGlobs: [...ws.allowGlobs] }
}

export async function detectWriteScopeViolations(workdir: string, snapshot: WriteScopeSnapshot): Promise<string[]> {
  const violations: string[] = []
  const stillPresent = new Set<string>()
  for (const entry of snapshot.files) {
    const abs = join(workdir, entry.path)
    const st = await stat(abs).catch(() => null)
    if (!st) { violations.push(`${entry.path}: deleted`); continue }
    stillPresent.add(entry.path)
    const bytes = await readFile(abs)
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== entry.sha256) violations.push(`${entry.path}: modified`)
  }
  for await (const rel of walkFiles(workdir)) {
    if (matchesAny(rel, DEFAULT_TRANSIENT_IGNORE_GLOBS)) continue
    if (!matchesAny(rel, snapshot.denyGlobs)) continue
    if (!stillPresent.has(rel) && !snapshot.files.some((f) => f.path === rel)) {
      violations.push(`${rel}: added`)
    }
  }
  return violations
}

export async function writeSnapshotSidecar(rootDir: string, rolloutId: string, snapshot: WriteScopeSnapshot | null): Promise<void> {
  if (!snapshot) return
  const dir = join(rootDir, 'rl-verifier', sanitizeId(rolloutId))
  await import('node:fs/promises').then((m) => m.mkdir(dir, { recursive: true }))
  await writeFile(join(dir, 'mtimes.json'), JSON.stringify(snapshot, null, 2))
}

async function* walkFiles(root: string, sub = ''): AsyncGenerator<string> {
  const abs = join(root, sub)
  let entries
  try { entries = await readdir(abs, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const child = sub ? `${sub}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* walkFiles(root, child)
    else if (entry.isFile()) yield child
  }
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchGlob(path, g))
}

function matchGlob(path: string, glob: string): boolean {
  // Support **, *, ?, and literal segments. Convert to regex.
  const re = '^' + glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__AGENT_KERNEL_DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__AGENT_KERNEL_DOUBLE_STAR__/g, '.*') + '$'
  return new RegExp(re).test(path)
}

function sanitizeId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._:-]+/g, '_')
  return cleaned.length > 0 ? cleaned : 'unknown'
}

export { relative as _relative }
