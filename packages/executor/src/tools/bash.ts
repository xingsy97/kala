import { spawn } from 'node:child_process'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import {
  optionalBoolean,
  optionalPositiveInt,
  optionalString,
  requireString,
} from './schema.js'
import { startBackgroundShell } from './background-shell.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT = 1_000_000

export const bashTool: Tool = {
  name: 'bash',
  async run(input, ctx) {
    const command = requireString(input, 'command')
    if (command.trim().length === 0) {
      throw new ToolError('EINVAL', 'command is empty')
    }
    const cwdInput = optionalString(input, 'cwd')
    const runInBackground = optionalBoolean(input, 'run_in_background') ?? false
    const timeoutMs =
      optionalPositiveInt(input, 'timeoutMs', 100) ?? DEFAULT_TIMEOUT_MS

    const cwd = cwdInput ?? ctx.cwd ?? ctx.sandbox.roots[0] ?? process.cwd()
    let resolvedCwd: string
    try {
      resolvedCwd = await ctx.sandbox.resolve(cwd, { cwd: ctx.cwd })
    } catch (err) {
      if (err instanceof SandboxError) {
        throw new ToolError('EACCES', 'cwd outside workspace')
      }
      throw err
    }

    // Race #1: caller aborted before spawn. Short-circuit so we don't leak
    // a subprocess whose only outcome would be an immediate SIGKILL.
    if (ctx.signal.aborted) {
      return `--- exit code: -1, duration: 0ms\n--- aborted before spawn`
    }

    if (runInBackground) {
      const task = await startBackgroundShell({ command, cwd: resolvedCwd })
      return JSON.stringify({ taskId: task.taskId, note: 'started' })
    }

    return await new Promise<string>((resolve) => {
      const start = Date.now()
      let settled = false
      const settle = (payload: string): void => {
        if (settled) return
        settled = true
        resolve(payload)
      }

      let child: ReturnType<typeof spawn>
      try {
        child = spawn('bash', ['-c', command], {
          cwd: resolvedCwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        // Synchronous spawn failure (e.g. cwd disappeared between resolve and
        // spawn). Report as a status marker so the LLM can react rather than
        // the loop hanging on an unresolved promise.
        const msg = err instanceof Error ? err.message : String(err)
        settle(`--- exit code: -1, duration: 0ms\n--- spawn failed: ${msg}`)
        return
      }

      const chunks: Buffer[] = []
      let bytes = 0
      let killedByTimeout = false
      let killedByAbort = false

      const onData = (buf: Buffer): void => {
        if (bytes >= MAX_OUTPUT) return
        const room = MAX_OUTPUT - bytes
        const slice = buf.length > room ? buf.subarray(0, room) : buf
        chunks.push(slice)
        bytes += slice.length
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)

      const timer = setTimeout(() => {
        killedByTimeout = true
        child.kill('SIGKILL')
      }, timeoutMs)

      const abortListener = (): void => {
        killedByAbort = true
        child.kill('SIGKILL')
      }
      ctx.signal.addEventListener('abort', abortListener, { once: true })

      const cleanup = (): void => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', abortListener)
      }

      // Async spawn failure (ENOENT for missing bash binary, EACCES on cwd,
      // etc.). Without this listener the promise would never resolve.
      child.on('error', (err) => {
        cleanup()
        const msg = err instanceof Error ? err.message : String(err)
        const duration = Date.now() - start
        settle(
          `--- exit code: -1, duration: ${duration}ms\n--- spawn failed: ${msg}`,
        )
      })

      child.on('close', (code, signal) => {
        cleanup()
        const duration = Date.now() - start
        const output = Buffer.concat(chunks).toString('utf8')
        // Exit code is null when the child was killed by a signal. Preserve
        // the distinction so callers can tell abort/timeout apart from a
        // clean non-zero exit.
        const exitLabel = code ?? (signal ? `signal:${signal}` : -1)
        const status = `--- exit code: ${exitLabel}, duration: ${duration}ms`
        const trailer = killedByTimeout
          ? `\n--- killed after ${timeoutMs}ms (timeout)`
          : killedByAbort
            ? `\n--- aborted`
            : ''
        settle(`${output}${status}${trailer}`)
      })
    })
  },
}
