/**
 * Client-side git status / diff, built on top of workspace:exec.
 *
 * Domain-of-one-package rule (see docs/planning/roadmap-notes/workspace-
 * exec-refactor.md): the executor no longer parses porcelain v1; that
 * lives here next to the panel that renders it. The wire types
 * (GitFileChange / GitStatusResult / GitDiffResult) stay in shared so
 * the component layer doesn't have to change.
 *
 * Behaviour matches the executor implementation this replaces:
 *
 * - `git rev-parse --show-toplevel` locates the repo root before running
 *   `git status --porcelain=v1 -z --branch` in that root.
 * - Diff reads three sides via `git show` (`HEAD:path`, `:path`) and one
 *   workspace read for the worktree file. `:path` for untracked files is
 *   the empty side.
 * - Same caps: 1000 files, 512KB per diff side, 5s status timeout,
 *   8s diff timeout.
 */

import type {
  ClientGitDiff,
  ClientGitStatus,
  GitDiffResult,
  GitFileChange,
  GitFileStatus,
  GitStatusResult,
} from '@agent-kernel/shared'

import { workspaceExec, workspaceReadBinary, type WorkspaceSocket } from './workspace-exec.js'

const STATUS_TIMEOUT_MS = 5_000
const DIFF_TIMEOUT_MS = 8_000
const STATUS_MAX_BYTES = 2 * 1024 * 1024
const DIFF_MAX_BYTES = 512 * 1024
const MAX_STATUS_FILES = 1_000

export async function gitStatus(socket: WorkspaceSocket, payload: ClientGitStatus): Promise<GitStatusResult> {
  const base = { requestId: payload.requestId, workspaceId: payload.workspaceId }
  const top = await workspaceExec(socket, payload.workspaceId, ['git', 'rev-parse', '--show-toplevel'], {
    cwd: payload.cwd,
    timeoutMs: STATUS_TIMEOUT_MS,
    maxOutputBytes: STATUS_MAX_BYTES,
  })
  if (top.error?.code === 'ETIMEDOUT') return { ...base, files: [], error: { code: 'timeout', message: 'git rev-parse timed out' } }
  if (top.error?.code === 'ENOENT') return { ...base, files: [], error: { code: 'git_unavailable', message: 'git is not installed on the executor' } }
  if (top.error?.code === 'EACCES') return { ...base, files: [], error: { code: 'executor_unavailable', message: top.error.message } }
  if (top.error) return { ...base, files: [], error: { code: 'internal_error', message: top.error.message } }
  if (top.exitCode !== 0) return { ...base, files: [], error: { code: 'not_git_repo', message: top.stderr.trim().slice(0, 500) || 'workspace is not a git repository' } }
  const repoRoot = top.stdout.trim()

  const status = await workspaceExec(socket, payload.workspaceId, ['git', 'status', '--porcelain=v1', '-z', '--branch'], {
    cwd: repoRoot,
    timeoutMs: STATUS_TIMEOUT_MS,
    maxOutputBytes: STATUS_MAX_BYTES,
  })
  if (status.error?.code === 'ETIMEDOUT') return { ...base, files: [], error: { code: 'timeout', message: 'git status timed out' } }
  if (status.error) return { ...base, files: [], error: { code: 'internal_error', message: status.error.message } }
  if (status.truncated) return { ...base, files: [], truncated: { reason: 'too_large', limit: STATUS_MAX_BYTES }, error: { code: 'internal_error', message: 'git status output is too large' } }
  if (status.exitCode !== 0) return { ...base, files: [], error: { code: 'internal_error', message: status.stderr.trim().slice(0, 500) || 'git status failed' } }

  const parsed = parsePorcelainStatus(status.stdout)
  return {
    ...base,
    repo: {
      root: repoRoot,
      ...(parsed.branch ? { branch: parsed.branch } : {}),
      ...(parsed.head ? { head: parsed.head } : {}),
    },
    files: parsed.files.slice(0, MAX_STATUS_FILES),
    ...(parsed.files.length > MAX_STATUS_FILES ? { truncated: { reason: 'too_many_files' as const, limit: MAX_STATUS_FILES } } : {}),
  }
}

export async function gitDiff(socket: WorkspaceSocket, payload: ClientGitDiff): Promise<GitDiffResult> {
  const base = { requestId: payload.requestId, workspaceId: payload.workspaceId }
  const status = await gitStatus(socket, { requestId: payload.requestId, workspaceId: payload.workspaceId, cwd: payload.cwd, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}) })
  if (status.error) {
    const errorCode: NonNullable<GitDiffResult['error']>['code'] =
      status.error.code === 'not_git_repo' || status.error.code === 'executor_unavailable' || status.error.code === 'git_unavailable' || status.error.code === 'timeout' || status.error.code === 'workspace_not_found'
        ? status.error.code
        : 'internal_error'
    return { ...base, error: { code: errorCode, message: status.error.message } }
  }
  const repoRoot = status.repo?.root
  if (!repoRoot) return { ...base, error: { code: 'not_git_repo', message: 'no repo root reported' } }
  const file = status.files.find((change) => change.path === payload.path || change.oldPath === payload.path)
  if (!file) return { ...base, error: { code: 'file_not_found', message: 'file is not changed in git status' } }

  const staged = payload.staged === true
  const oldSource = staged ? headSource(file) : indexSource(file)
  const newSource = staged ? indexSource(file) : worktreeSource(file)
  const oldPath = oldSource === 'head' && file.oldPath ? file.oldPath : payload.path

  const oldBuf = await readGitSide(socket, payload.workspaceId, repoRoot, oldPath, oldSource)
  const newBuf = await readGitSide(socket, payload.workspaceId, repoRoot, payload.path, newSource)
  if (!oldBuf.ok) return { ...base, file, error: oldBuf.error }
  if (!newBuf.ok) return { ...base, file, error: newBuf.error }

  const oldText = decodeText(oldBuf.buffer)
  const newText = decodeText(newBuf.buffer)
  if (!oldText.ok || !newText.ok) return { ...base, file, error: { code: 'binary_file', message: 'binary file cannot be diffed as text' } }
  const truncated = truncation(oldBuf.truncated, newBuf.truncated)
  return {
    ...base,
    file,
    oldText: oldText.text,
    newText: newText.text,
    language: languageForPath(payload.path),
    ...(truncated ? { truncated } : {}),
  }
}

// -----------------------------------------------------------------------
// Pure helpers (unit-testable). Moved verbatim from
// packages/executor/src/git-handlers.ts.
// -----------------------------------------------------------------------

export function parsePorcelainStatus(raw: string): { branch?: string; head?: string; files: GitFileChange[] } {
  const parts = raw.split('\0').filter((part) => part.length > 0)
  let branch: string | undefined
  let head: string | undefined
  const files: GitFileChange[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!
    if (entry.startsWith('## ')) {
      const value = entry.slice(3)
      branch = value.split('...')[0]?.trim() || undefined
      if (branch === 'HEAD (no branch)') branch = undefined
      continue
    }
    if (entry.length < 4) continue
    const x = entry[0]!
    const y = entry[1]!
    const path = entry.slice(3)
    let oldPath: string | undefined
    if (x === 'R' || x === 'C') {
      oldPath = parts[i + 1]
      i += 1
    }
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status: statusFor(x, y),
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' || x === '?',
    })
  }
  return { ...(branch ? { branch } : {}), ...(head ? { head } : {}), files }
}

function statusFor(x: string, y: string): GitFileStatus {
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted'
  const code = x !== ' ' ? x : y
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R') return 'renamed'
  if (code === 'C') return 'copied'
  if (code === 'T') return 'typechanged'
  return 'modified'
}

type GitSide = 'empty' | 'head' | 'index' | 'worktree'

function headSource(file: GitFileChange): GitSide {
  return file.status === 'added' || file.status === 'untracked' ? 'empty' : 'head'
}

function indexSource(file: GitFileChange): GitSide {
  if (file.status === 'untracked') return 'empty'
  if (file.status === 'deleted' && file.staged) return 'empty'
  return 'index'
}

function worktreeSource(file: GitFileChange): GitSide {
  return file.status === 'deleted' ? 'empty' : 'worktree'
}

async function readGitSide(
  socket: WorkspaceSocket,
  workspaceId: string,
  repoRoot: string,
  path: string,
  source: GitSide,
): Promise<{ ok: true; buffer: Uint8Array; truncated?: boolean } | { ok: false; error: NonNullable<GitDiffResult['error']> }> {
  if (source === 'empty') return { ok: true, buffer: new Uint8Array(0) }
  if (source === 'worktree') {
    const abs = joinPath(repoRoot, path)
    const res = await workspaceReadBinary(socket, workspaceId, abs, { maxBytes: DIFF_MAX_BYTES + 1 })
    if (res.error) {
      if (res.error.code === 'ENOENT') return { ok: true, buffer: new Uint8Array(0) }
      return { ok: false, error: { code: 'file_not_found', message: res.error.message } }
    }
    const buffer = base64ToBytes(res.base64)
    if (buffer.length > DIFF_MAX_BYTES) return { ok: true, buffer: buffer.subarray(0, DIFF_MAX_BYTES), truncated: true }
    return { ok: true, buffer }
  }
  const rev = source === 'head' ? `HEAD:${path}` : `:${path}`
  const result = await workspaceExec(socket, workspaceId, ['git', 'show', rev], {
    cwd: repoRoot,
    timeoutMs: DIFF_TIMEOUT_MS,
    maxOutputBytes: DIFF_MAX_BYTES + 1,
  })
  if (result.error?.code === 'ETIMEDOUT') return { ok: false, error: { code: 'timeout', message: 'git show timed out' } }
  if (result.error) return { ok: false, error: { code: 'file_not_found', message: result.error.message } }
  if (result.truncated) {
    const bytes = new TextEncoder().encode(result.stdout)
    return { ok: true, buffer: bytes.subarray(0, DIFF_MAX_BYTES), truncated: true }
  }
  if (result.exitCode !== 0) {
    if (source === 'head') return { ok: true, buffer: new Uint8Array(0) }
    return { ok: false, error: { code: 'file_not_found', message: result.stderr.trim().slice(0, 500) || 'file not found in git index' } }
  }
  return { ok: true, buffer: new TextEncoder().encode(result.stdout) }
}

function decodeText(buffer: Uint8Array): { ok: true; text: string } | { ok: false } {
  if (buffer.includes(0)) return { ok: false }
  return { ok: true, text: new TextDecoder('utf-8', { fatal: false }).decode(buffer) }
}

function truncation(oldTruncated: boolean | undefined, newTruncated: boolean | undefined): GitDiffResult['truncated'] | undefined {
  if (oldTruncated && newTruncated) return { side: 'both', maxBytes: DIFF_MAX_BYTES }
  if (oldTruncated) return { side: 'old', maxBytes: DIFF_MAX_BYTES }
  if (newTruncated) return { side: 'new', maxBytes: DIFF_MAX_BYTES }
  return undefined
}

function joinPath(a: string, b: string): string {
  if (!a) return b
  if (a.endsWith('/')) return `${a}${b}`
  return `${a}/${b}`
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'ts' || ext === 'tsx') return 'typescript'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript'
  if (ext === 'json') return 'json'
  if (ext === 'css') return 'css'
  if (ext === 'html') return 'html'
  if (ext === 'md') return 'markdown'
  if (ext === 'py') return 'python'
  if (ext === 'rs') return 'rust'
  if (ext === 'go') return 'go'
  if (ext === 'java') return 'java'
  if (ext === 'sh' || ext === 'bash') return 'shell'
  return 'plaintext'
}
