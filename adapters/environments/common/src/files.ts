import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

import { canonicalJson, sha256Hex } from '@agent-kernel/eval-protocol'
import type { SandboxSnapshot } from '@agent-kernel/eval-sdk'

export function safeInstanceName(prefix: string, trialId: string): string {
  const trial = trialId.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-').slice(0, 28).replace(/-$/u, '') || 'trial'
  return (prefix + '-' + trial + '-' + randomUUID().slice(0, 8)).slice(0, 63)
}

export function sandboxPath(value: string, allowedRoots = ['/workspace', '/artifacts', '/tmp']): string {
  const path = normalize(value).replaceAll('\\', '/')
  if (!path.startsWith('/') || path.includes('/../') || path.endsWith('/..')) throw new Error('sandbox path must be absolute and contained')
  if (!allowedRoots.some((root) => path === root || path.startsWith(root + '/'))) throw new Error('sandbox path is outside allowed roots: ' + value)
  return path
}

export function relativeArtifactPath(value: string): string {
  const path = normalize(value).replaceAll('\\', '/').replace(/^\.\//u, '')
  if (!path || path === '.' || isAbsolute(value) || path === '..' || path.startsWith('../') || path.includes('/../')) throw new Error('artifact path must be relative and contained')
  return path
}

export async function containedHostPath(root: string, candidate: string, mustExist: boolean): Promise<string> {
  const canonicalRoot = mustExist ? await realpath(resolve(root)) : resolve(root)
  const resolved = resolve(candidate)
  const path = mustExist ? await realpath(resolved) : resolved
  const rel = relative(canonicalRoot, path)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('host path escaped Worker data root')
  return path
}

export async function snapshotDirectory(root: string, createdAt = new Date().toISOString()): Promise<SandboxSnapshot> {
  const files: Array<{ path: string; bytes: number; sha256: string }> = []
  await walk(await realpath(root), '', files)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { snapshotId: 'snapshot-' + randomUUID(), createdAt, manifestHash: await sha256Hex(canonicalJson(files)), files }
}

async function walk(root: string, relativePath: string, files: Array<{ path: string; bytes: number; sha256: string }>): Promise<void> {
  const directory = join(root, relativePath)
  for (const name of await readdir(directory)) {
    const childRelative = relativePath ? relativePath + '/' + name : name
    const child = join(root, childRelative)
    const metadata = await lstat(child)
    if (metadata.isSymbolicLink()) continue
    if (metadata.isDirectory()) await walk(root, childRelative, files)
    else if (metadata.isFile()) {
      const body = await readFile(child)
      files.push({ path: childRelative, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') })
    }
  }
}

export async function withTemporaryDirectory<T>(parent: string, prefix: string, action: (directory: string) => Promise<T>): Promise<T> {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, prefix))
  try { return await action(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
