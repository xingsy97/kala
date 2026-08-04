import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pipeline } from 'node:stream/promises'

import type { SandboxExecResult } from '@agent-kernel/eval-sdk'

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

type RunProcessInput = {
  command: string
  args: readonly string[]
  stdin?: string | Uint8Array
  timeoutMs: number
  signal?: AbortSignal
  environment?: NodeJS.ProcessEnv
  onAbort?: (reason: 'timeout' | 'cancelled') => Promise<void>
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export async function runProcess(input: RunProcessInput): Promise<SandboxExecResult> {
  return await runProcessInternal(input)
}

/** Stream binary stdout to a local file without converting it through UTF-8.
 * The destination is replaced atomically only after the producer exits cleanly. */
export async function runProcessToFile(input: Omit<RunProcessInput, 'onStdout'> & { destination: string }): Promise<SandboxExecResult> {
  const destination = resolve(input.destination)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = destination + '.partial-' + randomUUID()
  let committed = false
  try {
    const result = await runProcessInternal(input, temporary)
    if (result.exitCode === 0 && !result.timedOut) {
      await rename(temporary, destination)
      committed = true
    }
    return result
  } finally {
    if (!committed) await rm(temporary, { force: true })
  }
}

async function runProcessInternal(input: RunProcessInput, stdoutFile?: string): Promise<SandboxExecResult> {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('process timeout must be a positive integer')
  const started = new Date()
  const child = spawn(input.command, input.args, { stdio: ['pipe', 'pipe', 'pipe'], env: input.environment ?? process.env })
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let outputExceeded = false
  let timedOut = false
  let cancelled = false
  let callbackError: unknown
  let aborting: Promise<void> | undefined
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
    if (current.byteLength + chunk.byteLength > MAX_OUTPUT_BYTES) {
      outputExceeded = true
      void abort('cancelled')
      return current
    }
    return Buffer.concat([current, chunk])
  }
  const observe = (callback: ((chunk: string) => void) | undefined, chunk: string): void => {
    if (!callback || callbackError) return
    try { callback(chunk) } catch (error) { callbackError = error; void abort('cancelled') }
  }
  let stdoutTransfer: Promise<void> | undefined
  if (stdoutFile) {
    stdoutTransfer = pipeline(child.stdout, createWriteStream(stdoutFile, { flags: 'wx', mode: 0o600 })).catch((error: unknown) => {
      callbackError = error
      void abort('cancelled')
    })
  } else {
    child.stdout.on('data', (chunk: Buffer<ArrayBufferLike>) => { stdout = append(stdout, chunk); observe(input.onStdout, stdoutDecoder.write(chunk)) })
  }
  child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => { stderr = append(stderr, chunk); observe(input.onStderr, stderrDecoder.write(chunk)) })
  const abort = async (reason: 'timeout' | 'cancelled'): Promise<void> => {
    if (aborting) return await aborting
    timedOut = reason === 'timeout'
    cancelled = reason === 'cancelled'
    aborting = (async () => {
      child.kill('SIGTERM')
      const kill = setTimeout(() => child.kill('SIGKILL'), 1_000)
      kill.unref()
      await input.onAbort?.(reason)
    })()
    await aborting
  }
  const externalAbort = () => { void abort('cancelled') }
  input.signal?.addEventListener('abort', externalAbort, { once: true })
  if (input.signal?.aborted) externalAbort()
  const timer = setTimeout(() => { void abort('timeout') }, input.timeoutMs)
  timer.unref()
  if (input.stdin !== undefined) child.stdin.end(input.stdin)
  else child.stdin.end()
  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    await aborting
    await stdoutTransfer
    if (!stdoutFile) observe(input.onStdout, stdoutDecoder.end())
    observe(input.onStderr, stderrDecoder.end())
    if (callbackError) throw callbackError
    if (outputExceeded) stderr = Buffer.concat([stderr, Buffer.from('\nprocess output exceeded 16 MiB limit')])
    return {
      exitCode: outcome.code, signal: outcome.signal ?? (cancelled ? 'SIGTERM' : undefined),
      stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
      startedAt: started.toISOString(), completedAt: new Date().toISOString(), timedOut,
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', externalAbort)
  }
}

export async function commandOk(command: string, args: readonly string[], timeoutMs = 30_000): Promise<SandboxExecResult> {
  return await runProcess({ command, args, timeoutMs })
}
