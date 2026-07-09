/**
 * Filesystem RPC handlers on the executor side.
 *
 * The dashboard drives three read-only inspection endpoints — directory
 * picker, workspace file search, single-file view. They intentionally
 * bypass the LLM / tool_call path so the browser can show file trees
 * without cluttering the transcript. Each returns a well-formed payload
 * regardless of failure so the dashboard doesn't crash on a partial
 * response.
 *
 * A fourth endpoint — overflow file read — mirrors the same shape and
 * serves spill files produced by `tools/overflow.ts` (executor caps
 * in-history tool output at 32 KB; the rest lands on disk under
 * `<workspaceRoot>/.agent-kernel/overflow/<sessionId>/<callId>.txt` and the
 * dashboard fetches it lazily via `client:read_overflow`).
 *
 * All handlers respect `sandbox.roots` if configured, falling back to
 * `process.cwd()` when the executor was started without a jail.
 */

import { cp, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import type {
  ClientReadOverflow,
  CopyOverflowSession,
  CopyOverflowSessionResult,
  DeleteOverflowSession,
  DeleteOverflowSessionResult,
  DirListResult,
  FileContentsResult,
  FileListEntry,
  FileListResult,
  OverflowContentsResult,
} from '@agent-kernel/shared'

import type { Sandbox } from './sandbox.js'

// ============================================================================
// listDirs — directory picker one-level-at-a-time
// ============================================================================

export async function listDirs(
  requestId: string,
  workspaceId: string,
  inputPath: string | undefined,
  sandbox: Sandbox,
): Promise<DirListResult> {
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const requested = inputPath && inputPath.trim().length > 0 ? inputPath : roots[0]!
  try {
    const resolved = await sandbox.resolve(requested)
    const entries = await readdir(resolved, { withFileTypes: true })
    const items = await Promise.all(entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map(async (entry) => {
        const path = join(resolved, entry.name)
        if (entry.isDirectory()) return { name: entry.name, path, type: 'directory' as const }
        const info = await stat(path).catch(() => undefined)
        return { name: entry.name, path, type: 'file' as const, ...(info ? { size: info.size } : {}) }
      }))
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return {
      requestId,
      workspaceId,
      path: resolved,
      roots,
      entries: items,
    }
  } catch (err) {
    return {
      requestId,
      workspaceId,
      path: requested,
      roots,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ============================================================================
// listFiles — workspace file search (used by the @-mention picker)
// ============================================================================

const FILE_LIST_SKIP_DIRS = new Set<string>([
  'node_modules',
  '.git',
  '.pnpm',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
])

const FILE_LIST_DEFAULT_LIMIT = 500
const FILE_LIST_MAX_LIMIT = 2000
const FILE_LIST_WALK_CEILING = 20000

type ListFilesPayload = {
  requestId: string
  workspaceId: string
  query?: string
  limit?: number
}

export async function listFiles(
  payload: ListFilesPayload,
  sandbox: Sandbox,
): Promise<FileListResult> {
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const rawLimit = payload.limit ?? FILE_LIST_DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(FILE_LIST_MAX_LIMIT, rawLimit))
  const query = (payload.query ?? '').trim().toLowerCase()
  const matches: FileListEntry[] = []
  let walked = 0
  let truncated = false

  try {
    outer: for (const root of roots) {
      const stack: string[] = [root]
      while (stack.length > 0) {
        if (walked >= FILE_LIST_WALK_CEILING) {
          truncated = true
          break outer
        }
        const dir = stack.pop()!
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          walked += 1
          if (entry.name.startsWith('.') && entry.name !== '.') {
            if (entry.isDirectory()) continue
          }
          if (entry.isDirectory()) {
            if (FILE_LIST_SKIP_DIRS.has(entry.name)) continue
            stack.push(join(dir, entry.name))
            continue
          }
          if (!entry.isFile()) continue
          const abs = join(dir, entry.name)
          const rel = relative(root, abs).split(sep).join('/')
          if (query.length > 0 && !rel.toLowerCase().includes(query)) continue
          if (matches.length >= limit) {
            truncated = true
            break outer
          }
          matches.push({ path: rel, size: 0 })
        }
      }
    }
  } catch (err) {
    return {
      requestId: payload.requestId,
      workspaceId: payload.workspaceId,
      files: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  matches.sort((a, b) => a.path.localeCompare(b.path))
  return {
    requestId: payload.requestId,
    workspaceId: payload.workspaceId,
    files: matches,
    truncated,
  }
}

// ============================================================================
// readWorkspaceFile — single-file view
// ============================================================================

const FILE_READ_DEFAULT_MAX_BYTES = 1024 * 1024
const FILE_READ_HARD_CEILING = 1024 * 1024
const FILE_BINARY_PROBE_BYTES = 8192
const IMAGE_MEDIA_TYPES = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
])
const VIEWABLE_BINARY_MEDIA_TYPES = new Map<string, string>([
  ['.pdf', 'application/pdf'],
])

type ReadFilePayload = {
  requestId: string
  workspaceId: string
  path: string
  maxBytes?: number
}

export async function readWorkspaceFile(
  payload: ReadFilePayload,
  sandbox: Sandbox,
): Promise<FileContentsResult> {
  const requested = payload.path?.trim() ?? ''
  const base = {
    requestId: payload.requestId,
    workspaceId: payload.workspaceId,
    path: requested,
  }
  if (requested.length === 0) {
    return { ...base, error: 'EINVAL: empty path' }
  }
  const cap = Math.max(
    1,
    Math.min(FILE_READ_HARD_CEILING, payload.maxBytes ?? FILE_READ_DEFAULT_MAX_BYTES),
  )
  try {
    const resolved = await sandbox.resolve(requested)
    const info = await stat(resolved)
    if (!info.isFile()) {
      return { ...base, error: 'ENOTFILE: not a regular file' }
    }
    const imageMediaType = imageMediaTypeFor(resolved)
    if (imageMediaType) {
      if (info.size > cap) {
        return { ...base, size: info.size, kind: 'too_large', truncated: true, error: `EFBIG: image is ${info.size} bytes (limit ${cap})` }
      }
      const content = (await readFile(resolved)).toString('base64')
      return { ...base, content, size: info.size, kind: 'image', encoding: 'base64', mediaType: imageMediaType }
    }
    const viewableBinaryMediaType = viewableBinaryMediaTypeFor(resolved)
    if (viewableBinaryMediaType) {
      if (info.size > cap) {
        return { ...base, size: info.size, kind: 'too_large', truncated: true, error: `EFBIG: file is ${info.size} bytes (limit ${cap})` }
      }
      const content = (await readFile(resolved)).toString('base64')
      return { ...base, content, size: info.size, kind: 'pdf', encoding: 'base64', mediaType: viewableBinaryMediaType }
    }
    const probe = await readPrefix(resolved, Math.min(FILE_BINARY_PROBE_BYTES, info.size))
    if (looksBinary(probe)) {
      return { ...base, size: info.size, kind: 'binary', error: 'EBINARY: file appears to be binary' }
    }
    if (info.size > cap) {
      const content = (await readPrefix(resolved, cap)).toString('utf8')
      return { ...base, content, size: info.size, kind: 'too_large', truncated: true, error: `EFBIG: file is ${info.size} bytes (limit ${cap})` }
    }
    const content = await readFile(resolved, 'utf8')
    return { ...base, content, size: info.size, kind: 'text' }
  } catch (err) {
    return { ...base, kind: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

function imageMediaTypeFor(path: string): string | undefined {
  const lower = path.toLowerCase()
  for (const [ext, mediaType] of IMAGE_MEDIA_TYPES) {
    if (lower.endsWith(ext)) return mediaType
  }
  return undefined
}

function viewableBinaryMediaTypeFor(path: string): string | undefined {
  const lower = path.toLowerCase()
  for (const [ext, mediaType] of VIEWABLE_BINARY_MEDIA_TYPES) {
    if (lower.endsWith(ext)) return mediaType
  }
  return undefined
}

async function readPrefix(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  let suspicious = 0
  for (const byte of buffer) {
    if (byte === 0) return true
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1
  }
  return suspicious / buffer.length > 0.08
}

// ============================================================================
// readOverflowFile — dashboard "View full output" for spilled tool results
// ============================================================================

const OVERFLOW_READ_MAX_BYTES = 4 * 1024 * 1024

const OVERFLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export async function readOverflowFile(
  payload: ClientReadOverflow,
  sandbox: Sandbox,
): Promise<OverflowContentsResult> {
  const { requestId, sessionId, callId } = payload
  const base = { requestId, sessionId, callId }
  if (!OVERFLOW_ID_PATTERN.test(sessionId) || !OVERFLOW_ID_PATTERN.test(callId)) {
    return { ...base, error: 'EINVAL: invalid session or call id' }
  }
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const workspaceRoot = roots[0]!
  const target = join(workspaceRoot, '.agent-kernel', 'overflow', sessionId, `${callId}.txt`)
  try {
    const resolved = await sandbox.resolve(target)
    const info = await stat(resolved)
    if (!info.isFile()) {
      return { ...base, error: 'ENOTFILE: overflow entry is not a regular file' }
    }
    if (info.size > OVERFLOW_READ_MAX_BYTES) {
      return { ...base, size: info.size, error: `EFBIG: overflow file is ${info.size} bytes (limit ${OVERFLOW_READ_MAX_BYTES})` }
    }
    const content = await readFile(resolved, 'utf8')
    return { ...base, content, size: info.size }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deleteOverflowSession(
  payload: DeleteOverflowSession,
  sandbox: Sandbox,
): Promise<DeleteOverflowSessionResult> {
  const { requestId, sessionId } = payload
  const base = { requestId, sessionId }
  if (!OVERFLOW_ID_PATTERN.test(sessionId)) {
    return { ...base, deleted: false, error: 'EINVAL: invalid session id' }
  }
  try {
    const target = await resolveOverflowSessionDir(sandbox, sessionId)
    await rm(target, { recursive: true, force: true })
    return { ...base, deleted: true }
  } catch (err) {
    return { ...base, deleted: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function copyOverflowSession(
  payload: CopyOverflowSession,
  sandbox: Sandbox,
): Promise<CopyOverflowSessionResult> {
  const { requestId, sourceSessionId, targetSessionId } = payload
  const base = { requestId, sourceSessionId, targetSessionId }
  if (!OVERFLOW_ID_PATTERN.test(sourceSessionId) || !OVERFLOW_ID_PATTERN.test(targetSessionId)) {
    return { ...base, copied: false, error: 'EINVAL: invalid session id' }
  }
  try {
    const source = await resolveOverflowSessionDir(sandbox, sourceSessionId)
    const target = await resolveOverflowSessionDir(sandbox, targetSessionId)
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true, force: false, errorOnExist: false }).catch((err: unknown) => {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return
      throw err
    })
    return { ...base, copied: true }
  } catch (err) {
    return { ...base, copied: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function resolveOverflowSessionDir(sandbox: Sandbox, sessionId: string): Promise<string> {
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const workspaceRoot = roots[0]!
  return await sandbox.resolve(join(workspaceRoot, '.agent-kernel', 'overflow', sessionId))
}
