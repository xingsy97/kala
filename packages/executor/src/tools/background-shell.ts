/**
 * Background-shell runtime.
 *
 * A single process-wide registry that owns detached bash children spawned by
 * the `bash` tool with `run_in_background: true`. The registry:
 *
 *  - Persists each child's stdout+stderr into an on-disk ring buffer under
 *    `${tmpdir}/.ak-tasks/<taskId>.log`, capped at MAX_LOG_BYTES so a chatty
 *    task can't fill the disk.
 *  - Tracks status metadata (start time, exit code / signal, bytes logged,
 *    bytes truncated by the ring buffer).
 *  - Emits change events so the executor's dashboard-facing WS handlers can
 *    push live updates without polling.
 *  - Evicts task metadata and log files GRACE_MS after the task exits, so an
 *    executor that stays up for weeks doesn't keep every completed task in
 *    memory forever.
 *
 * The runtime is intentionally in-memory / non-persistent: a restarted
 * executor kills its process group (children are `spawn`ed as detached but
 * inherit the exit signal by default) and the registry starts empty.
 */

import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  appendFile,
  mkdir,
  readFile,
  stat,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ulid } from 'ulid'
import { shellArgv, type ShellSpec } from './shell-runtime.js'

const TASK_DIR = join(tmpdir(), '.ak-tasks')

const MAX_LOG_BYTES = 4 * 1024 * 1024
const UPDATE_THROTTLE_MS = 400
const GRACE_MS = 15 * 60 * 1000

export type BackgroundTaskStatus = 'running' | 'exited' | 'killed' | 'signaled'

export type BackgroundTaskSummary = {
  taskId: string
  sessionId: string
  command: string
  cwd: string
  pid?: number
  startedAt: string
  endedAt?: string
  status: BackgroundTaskStatus
  exitCode: number | null
  signal: string | null
  bytesLogged: number
  bytesTruncated: number
}

export type BgTaskChange =
  | { kind: 'spawned'; task: BackgroundTaskSummary }
  | {
      kind: 'output'
      task: BackgroundTaskSummary
      delta: { fromOffset: number; content: string }
    }
  | { kind: 'ended'; task: BackgroundTaskSummary }
  | { kind: 'evicted'; sessionId: string; taskId: string }

type Task = {
  taskId: string
  sessionId: string
  command: string
  cwd: string
  logPath: string
  child: ChildProcess
  startedAt: number
  endedAt?: number
  status: BackgroundTaskStatus
  exitCode: number | null
  signal: string | null
  bytesLogged: number
  bytesTruncated: number
  bufferSize: number
  pendingDelta: string
  pendingOffset: number | null
  flushTimer: NodeJS.Timeout | null
  evictTimer: NodeJS.Timeout | null
}

const tasks = new Map<string, Task>()
const emitter = new EventEmitter()

emitter.setMaxListeners(50)

export function subscribeBackgroundTasks(
  handler: (change: BgTaskChange) => void,
): () => void {
  emitter.on('change', handler)
  return () => {
    emitter.off('change', handler)
  }
}

export function listBackgroundTasks(sessionId: string): readonly BackgroundTaskSummary[] {
  return [...tasks.values()]
    .filter((task) => task.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(summaryOf)
}

export function getBackgroundTask(
  taskId: string,
): BackgroundTaskSummary | null {
  const task = tasks.get(taskId)
  return task ? summaryOf(task) : null
}

export async function startBackgroundShell(params: {
  sessionId: string
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
  shell: ShellSpec
}): Promise<BackgroundTaskSummary> {
  await mkdir(TASK_DIR, { recursive: true })
  const taskId = ulid()
  const logPath = join(TASK_DIR, `${taskId}.log`)
  await writeFile(logPath, '', 'utf8')

  const child = spawn(params.shell.executable, shellArgv(params.shell, params.command), {
    cwd: params.cwd,
    env: params.env ?? process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const task: Task = {
    taskId,
    sessionId: params.sessionId,
    command: params.command,
    cwd: params.cwd,
    logPath,
    child,
    startedAt: Date.now(),
    status: 'running',
    exitCode: null,
    signal: null,
    bytesLogged: 0,
    bytesTruncated: 0,
    bufferSize: 0,
    pendingDelta: '',
    pendingOffset: null,
    flushTimer: null,
    evictTimer: null,
  }
  tasks.set(taskId, task)

  const onData = (buf: Buffer): void => {
    void appendToLog(task, buf)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  child.on('close', (code, signal) => {
    task.endedAt = Date.now()
    task.exitCode = code
    task.signal = signal
    task.status = signal ? (signal === 'SIGTERM' ? 'killed' : 'signaled') : 'exited'
    if (task.pendingDelta.length > 0 && task.flushTimer === null) {
      flushDelta(task)
    }
    emitChange({ kind: 'ended', task: summaryOf(task) })
    task.evictTimer = setTimeout(() => void evict(taskId), GRACE_MS)
    task.evictTimer.unref?.()
  })

  child.on('error', (err) => {
    task.endedAt = Date.now()
    task.status = 'signaled'
    task.exitCode = null
    void appendToLog(task, Buffer.from(`\n[spawn error] ${err.message}\n`))
    emitChange({ kind: 'ended', task: summaryOf(task) })
    task.evictTimer = setTimeout(() => void evict(taskId), GRACE_MS)
    task.evictTimer.unref?.()
  })

  child.unref()
  emitChange({ kind: 'spawned', task: summaryOf(task) })
  return summaryOf(task)
}

export async function readBackgroundShell(params: {
  taskId: string
  sessionId: string
  offset?: number
  block?: boolean
  timeoutMs?: number
}): Promise<{
  content: string
  nextOffset: number
  done: boolean
  status: BackgroundTaskStatus
  bytesTruncated: number
}> {
  const task = tasks.get(params.taskId)
  if (!task || task.sessionId !== params.sessionId) throw new Error(`unknown background task: ${params.taskId}`)
  if (params.block && task.status === 'running') {
    await waitForExit(task, params.timeoutMs ?? 30_000)
  }
  const buf = await safeReadFile(task.logPath)
  const bufferStart = task.bytesLogged - buf.length
  const requestedOffset = params.offset ?? 0
  const sliceFrom = Math.max(0, requestedOffset - bufferStart)
  const slice = buf.subarray(Math.min(sliceFrom, buf.length))
  const nextOffset = bufferStart + buf.length
  return {
    content: slice.toString('utf8'),
    nextOffset,
    done: task.status !== 'running',
    status: task.status,
    bytesTruncated: task.bytesTruncated,
  }
}

export async function killBackgroundShell(taskId: string, sessionId: string): Promise<boolean> {
  const task = tasks.get(taskId)
  if (!task || task.sessionId !== sessionId) throw new Error(`unknown background task: ${taskId}`)
  if (task.status !== 'running') return false
  if (process.platform === 'win32' && task.child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(task.child.pid), '/T', '/F'], { stdio: 'ignore' })
    return true
  }
  return task.child.kill('SIGTERM')
}

async function appendToLog(task: Task, buf: Buffer): Promise<void> {
  const incoming = buf.length
  task.bytesLogged += incoming

  let toWrite: Buffer
  if (task.bufferSize + incoming <= MAX_LOG_BYTES) {
    toWrite = buf
    task.bufferSize += incoming
  } else {
    const overflow = task.bufferSize + incoming - MAX_LOG_BYTES
    task.bytesTruncated += overflow
    if (incoming >= MAX_LOG_BYTES) {
      toWrite = buf.subarray(incoming - MAX_LOG_BYTES)
      try {
        await truncate(task.logPath, 0)
      } catch {
        // Best-effort — a missing file on race with eviction is fine.
      }
      task.bufferSize = toWrite.length
    } else {
      const keepFromBuffer = MAX_LOG_BYTES - incoming
      try {
        const existing = await safeReadFile(task.logPath)
        const kept = existing.subarray(existing.length - keepFromBuffer)
        await writeFile(task.logPath, kept)
        task.bufferSize = kept.length
      } catch {
        task.bufferSize = 0
      }
      toWrite = buf
      task.bufferSize += incoming
    }
  }

  try {
    await appendFile(task.logPath, toWrite)
  } catch {
    // If the log file is gone (evicted while task is somehow still writing),
    // drop the write silently. Task state is already the source of truth.
    return
  }

  const chunk = toWrite.toString('utf8')
  if (task.pendingOffset === null) {
    task.pendingOffset = task.bytesLogged - toWrite.length
  }
  task.pendingDelta += chunk

  if (task.flushTimer === null) {
    task.flushTimer = setTimeout(() => flushDelta(task), UPDATE_THROTTLE_MS)
    task.flushTimer.unref?.()
  }
}

function flushDelta(task: Task): void {
  if (task.flushTimer !== null) {
    clearTimeout(task.flushTimer)
    task.flushTimer = null
  }
  if (task.pendingDelta.length === 0 || task.pendingOffset === null) return
  const delta = {
    fromOffset: task.pendingOffset,
    content: task.pendingDelta,
  }
  task.pendingDelta = ''
  task.pendingOffset = null
  emitChange({ kind: 'output', task: summaryOf(task), delta })
}

async function evict(taskId: string): Promise<void> {
  const task = tasks.get(taskId)
  if (!task) return
  tasks.delete(taskId)
  try {
    await unlink(task.logPath)
  } catch {
    // Best-effort.
  }
  emitChange({ kind: 'evicted', sessionId: task.sessionId, taskId })
}

async function waitForExit(task: Task, timeoutMs: number): Promise<void> {
  if (task.status !== 'running') return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    task.child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  try {
    await stat(task.logPath)
  } catch {
    // Ignore; readFile will surface the actual error below.
  }
}

async function safeReadFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch {
    return Buffer.alloc(0)
  }
}

function emitChange(change: BgTaskChange): void {
  emitter.emit('change', change)
}

function summaryOf(task: Task): BackgroundTaskSummary {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    command: task.command,
    cwd: task.cwd,
    ...(typeof task.child.pid === 'number' ? { pid: task.child.pid } : {}),
    startedAt: new Date(task.startedAt).toISOString(),
    ...(task.endedAt ? { endedAt: new Date(task.endedAt).toISOString() } : {}),
    status: task.status,
    exitCode: task.exitCode,
    signal: task.signal,
    bytesLogged: task.bytesLogged,
    bytesTruncated: task.bytesTruncated,
  }
}

// Test-only: reset all state so vitest can start each case fresh.
export function __resetBackgroundShellRegistryForTests(): void {
  for (const task of tasks.values()) {
    if (task.flushTimer) clearTimeout(task.flushTimer)
    if (task.evictTimer) clearTimeout(task.evictTimer)
    if (task.status === 'running') {
      try {
        task.child.kill('SIGKILL')
      } catch {
        // Fine.
      }
    }
  }
  tasks.clear()
  emitter.removeAllListeners('change')
}
