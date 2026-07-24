/**
 * Generic workspace exec: dashboard-initiated, non-agent-facing.
 *
 * The executor resolves cwd through the same sandbox as agent tools, caps
 * stdout/stderr, and returns protocol-shaped errors instead of throwing.
 */

import { spawn } from 'node:child_process'

import type {
  WorkspaceExecRequest,
  WorkspaceExecResponse,
} from '@agent-kernel/shared/workspace-exec'

import type { Sandbox } from '../sandbox.js'
import { SandboxError } from '../sandbox.js'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024

export async function workspaceExec(
  req: WorkspaceExecRequest,
  sandbox: Sandbox,
): Promise<WorkspaceExecResponse> {
  const requestId = req.requestId
  if (!Array.isArray(req.argv) || req.argv.length === 0 || typeof req.argv[0] !== 'string') {
    return errorResponse(requestId, 'EINVAL', 'argv must be a non-empty string array')
  }
  const timeoutMs = clampTimeout(req.timeoutMs)
  const maxOutputBytes = req.maxOutputBytes && req.maxOutputBytes > 0 ? req.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES

  let cwd: string
  try {
    cwd = await sandbox.resolve(req.cwd ?? '.')
  } catch (err) {
    if (err instanceof SandboxError) return errorResponse(requestId, 'EACCES', err.message)
    return errorResponse(requestId, 'EINVAL', err instanceof Error ? err.message : String(err))
  }

  const start = Date.now()
  return await new Promise<WorkspaceExecResponse>((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false

    const child = spawn(req.argv[0]!, req.argv.slice(1), {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)

    if (req.stdin && child.stdin) {
      child.stdin.write(req.stdin)
    }
    if (child.stdin) child.stdin.end()

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxOutputBytes) {
        stdoutTruncated = true
        return
      }
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > maxOutputBytes) {
        stderrTruncated = true
        return
      }
      stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        resolvePromise(errorResponse(requestId, 'ENOENT', err.message))
        return
      }
      resolvePromise(errorResponse(requestId, 'EIO', err.message))
    })

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      const truncated = stdoutTruncated || stderrTruncated
        ? { stdoutBytes, stderrBytes }
        : undefined
      const timedOut = signal === 'SIGKILL' && durationMs >= timeoutMs
      resolvePromise({
        requestId,
        stdout,
        stderr,
        exitCode: exitCode ?? null,
        durationMs,
        ...(truncated ? { truncated } : {}),
        ...(timedOut ? { error: { code: 'ETIMEDOUT', message: `exceeded ${timeoutMs}ms` } } : {}),
      })
    })
  })
}

function clampTimeout(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS
  return Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(requested)))
}

function errorResponse(
  requestId: string,
  code: 'EACCES' | 'ENOENT' | 'ETIMEDOUT' | 'EINVAL' | 'EIO',
  message: string,
): WorkspaceExecResponse {
  return {
    requestId,
    stdout: '',
    stderr: '',
    exitCode: null,
    durationMs: 0,
    error: { code, message },
  }
}
