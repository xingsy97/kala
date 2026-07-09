import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ClientGitDiff,
  ClientGitStatus,
  GitDiffResult,
  GitFileChange,
  GitFileStatus,
  GitStatusResult,
} from '@agent-kernel/shared'

import type { Sandbox } from './sandbox.js'

const STATUS_TIMEOUT_MS = 5_000
const DIFF_TIMEOUT_MS = 8_000
const STATUS_MAX_BYTES = 2 * 1024 * 1024
const DIFF_MAX_BYTES = 512 * 1024
const MAX_STATUS_FILES = 1_000

type GitRunResult = {
  exitCode: number | null
  stdout: Buffer
  stderr: Buffer
  timedOut?: boolean
  outputTooLarge?: boolean
  spawnError?: string
}

export async function gitStatus(payload: ClientGitStatus, sandbox: Sandbox): Promise<GitStatusResult> {
  const base = { requestId: payload.requestId, workspaceId: payload.workspaceId }
  const cwd = await workspaceCwd(sandbox, payload.cwd).catch(() => undefined)
  if (!cwd) return { ...base, files: [], error: { code: 'workspace_not_found', message: 'workspace root is unavailable' } }

  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd, timeoutMs: STATUS_TIMEOUT_MS, maxStdoutBytes: STATUS_MAX_BYTES })
  if (top.spawnError) return { ...base, files: [], error: { code: 'git_unavailable', message: top.spawnError } }
  if (top.timedOut) return { ...base, files: [], error: { code: 'timeout', message: 'git rev-parse timed out' } }
  if (top.exitCode !== 0) return { ...base, files: [], error: { code: 'not_git_repo', message: gitError(top, 'workspace is not a git repository') } }
  const repoRoot = top.stdout.toString('utf8').trim()

  const status = await runGit(['status', '--porcelain=v1', '-z', '--branch'], { cwd: repoRoot, timeoutMs: STATUS_TIMEOUT_MS, maxStdoutBytes: STATUS_MAX_BYTES })
  if (status.spawnError) return { ...base, files: [], error: { code: 'git_unavailable', message: status.spawnError } }
  if (status.timedOut) return { ...base, files: [], error: { code: 'timeout', message: 'git status timed out' } }
  if (status.outputTooLarge) return { ...base, files: [], truncated: { reason: 'too_large', limit: STATUS_MAX_BYTES }, error: { code: 'internal_error', message: 'git status output is too large' } }
  if (status.exitCode !== 0) return { ...base, files: [], error: { code: 'internal_error', message: gitError(status, 'git status failed') } }

  const parsed = parsePorcelainStatus(status.stdout.toString('utf8'))
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

export async function gitDiff(payload: ClientGitDiff, sandbox: Sandbox): Promise<GitDiffResult> {
  const base = { requestId: payload.requestId, workspaceId: payload.workspaceId }
  const cwd = await workspaceCwd(sandbox, payload.cwd).catch(() => undefined)
  if (!cwd) return { ...base, error: { code: 'workspace_not_found', message: 'workspace root is unavailable' } }

  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd, timeoutMs: DIFF_TIMEOUT_MS, maxStdoutBytes: STATUS_MAX_BYTES })
  if (top.spawnError) return { ...base, error: { code: 'git_unavailable', message: top.spawnError } }
  if (top.timedOut) return { ...base, error: { code: 'timeout', message: 'git rev-parse timed out' } }
  if (top.exitCode !== 0) return { ...base, error: { code: 'not_git_repo', message: gitError(top, 'workspace is not a git repository') } }
  const repoRoot = top.stdout.toString('utf8').trim()

  const status = await gitStatus(payload, sandbox)
  if (status.error) {
    const code = status.error.code === 'not_git_repo' || status.error.code === 'executor_unavailable' || status.error.code === 'git_unavailable' || status.error.code === 'timeout' || status.error.code === 'workspace_not_found'
      ? status.error.code
      : 'internal_error'
    return { ...base, error: { code, message: status.error.message } }
  }
  const file = status.files.find((change) => change.path === payload.path || change.oldPath === payload.path)
  if (!file) return { ...base, error: { code: 'file_not_found', message: 'file is not changed in git status' } }

  const staged = payload.staged === true
  const oldSource = staged ? headSource(file) : indexSource(file)
  const newSource = staged ? indexSource(file) : worktreeSource(file)
  const oldPath = oldSource === 'head' && file.oldPath ? file.oldPath : payload.path
  const oldBuf = await readGitSide(repoRoot, oldPath, oldSource)
  const newBuf = await readGitSide(repoRoot, payload.path, newSource)
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

async function workspaceCwd(sandbox: Sandbox, cwd?: string): Promise<string> {
  return await sandbox.resolve(cwd?.trim() || sandbox.roots[0] || process.cwd())
}

function runGit(args: readonly string[], opts: { cwd: string; timeoutMs: number; maxStdoutBytes: number }): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args as string[], { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let settled = false
    const finish = (result: GitRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ exitCode: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut: true })
    }, opts.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > opts.maxStdoutBytes) {
        const used = stdout.reduce((sum, part) => sum + part.length, 0)
        const remaining = Math.max(0, opts.maxStdoutBytes - used)
        if (remaining > 0) stdout.push(chunk.subarray(0, remaining))
        child.kill('SIGKILL')
        finish({ exitCode: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), outputTooLarge: true })
        return
      }
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (err) => finish({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), spawnError: err.message }))
    child.on('close', (code) => finish({ exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }))
  })
}

function gitError(result: GitRunResult, fallback: string): string {
  const stderr = result.stderr.toString('utf8').trim()
  return stderr.length > 0 ? stderr.slice(0, 500) : fallback
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

async function readGitSide(repoRoot: string, path: string, source: GitSide): Promise<{ ok: true; buffer: Buffer; truncated?: boolean } | { ok: false; error: NonNullable<GitDiffResult['error']> }> {
  if (source === 'empty') return { ok: true, buffer: Buffer.alloc(0) }
  if (source === 'worktree') {
    try {
      const buffer = await readFile(join(repoRoot, path))
      if (buffer.length > DIFF_MAX_BYTES) return { ok: true, buffer: buffer.subarray(0, DIFF_MAX_BYTES), truncated: true }
      return { ok: true, buffer }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('ENOENT')) return { ok: true, buffer: Buffer.alloc(0) }
      return { ok: false, error: { code: 'file_not_found', message } }
    }
  }
  const rev = source === 'head' ? `HEAD:${path}` : `:${path}`
  const result = await runGit(['show', rev], { cwd: repoRoot, timeoutMs: DIFF_TIMEOUT_MS, maxStdoutBytes: DIFF_MAX_BYTES + 1 })
  if (result.timedOut) return { ok: false, error: { code: 'timeout', message: 'git show timed out' } }
  if (result.outputTooLarge) return { ok: true, buffer: result.stdout.subarray(0, DIFF_MAX_BYTES), truncated: true }
  if (result.exitCode !== 0) {
    if (source === 'head') return { ok: true, buffer: Buffer.alloc(0) }
    return { ok: false, error: { code: 'file_not_found', message: gitError(result, 'file not found in git index') } }
  }
  return { ok: true, buffer: result.stdout }
}

function decodeText(buffer: Buffer): { ok: true; text: string } | { ok: false } {
  if (buffer.includes(0)) return { ok: false }
  return { ok: true, text: buffer.toString('utf8') }
}

function truncation(oldTruncated: boolean | undefined, newTruncated: boolean | undefined): GitDiffResult['truncated'] | undefined {
  if (oldTruncated && newTruncated) return { side: 'both', maxBytes: DIFF_MAX_BYTES }
  if (oldTruncated) return { side: 'old', maxBytes: DIFF_MAX_BYTES }
  if (newTruncated) return { side: 'new', maxBytes: DIFF_MAX_BYTES }
  return undefined
}

function languageForPath(path: string): string {
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
