/**
 * Filesystem RPC handlers on the executor side.
 *
 * The dashboard drives three read-only inspection endpoints  -  directory
 * picker, workspace file search, single-file preview. They intentionally
 * bypass the LLM / tool_call path so the browser can show file trees
 * without cluttering the transcript. Each returns a well-formed payload
 * regardless of failure so the dashboard doesn't crash on a partial
 * response.
 *
 * A fourth endpoint  -  overflow file read  -  mirrors the same shape and
 * serves spill files produced by `tools/overflow.ts` (executor caps
 * in-history tool output at 32 KB; the rest lands on disk under
 * `<workspaceRoot>/.agent-kernel/overflow/<sessionId>/<callId>.txt` and the
 * dashboard fetches it lazily via `client:read_overflow`).
 *
 * All handlers respect `sandbox.roots` if configured, falling back to
 * `process.cwd()` when the executor was started without a jail.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import type {
  ClientReadOverflow,
  DirListResult,
  FileContentsResult,
  FileListEntry,
  FileListResult,
  OverflowContentsResult,
} from '@agent-kernel/shared'

import type { Sandbox } from './sandbox.js'

// ============================================================================
// listDirs  -  directory picker one-level-at-a-time
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
    return {
      requestId,
      workspaceId,
      path: resolved,
      roots,
      entries: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: join(resolved, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
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
// listFiles  -  workspace file search (used by the @-mention picker)
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
// readWorkspaceFile  -  single-file preview
// ============================================================================

const FILE_READ_DEFAULT_MAX_BYTES = 64 * 1024
const FILE_READ_HARD_CEILING = 512 * 1024

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
    if (info.size > cap) {
      return { ...base, size: info.size, error: `EFBIG: file is ${info.size} bytes (limit ${cap})` }
    }
    const content = await readFile(resolved, 'utf8')
    return { ...base, content, size: info.size }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

// ============================================================================
// readOverflowFile  -  dashboard "View full output" for spilled tool results
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
