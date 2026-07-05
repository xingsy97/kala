import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ulid } from 'ulid'

const TASK_DIR = join(tmpdir(), '.ak-tasks')

export type BackgroundTask = {
  readonly taskId: string
  readonly logPath: string
  readonly child: ChildProcess
  readonly startedAt: number
  exitCode?: number | null
  signal?: NodeJS.Signals | null
}

const tasks = new Map<string, BackgroundTask>()

export async function startBackgroundShell(params: {
  command: string
  cwd: string
}): Promise<BackgroundTask> {
  await mkdir(TASK_DIR, { recursive: true })
  const taskId = ulid()
  const logPath = join(TASK_DIR, `${taskId}.log`)
  await writeFile(logPath, '', 'utf8')
  const child = spawn('bash', ['-c', params.command], {
    cwd: params.cwd,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const task: BackgroundTask = {
    taskId,
    logPath,
    child,
    startedAt: Date.now(),
  }
  tasks.set(taskId, task)
  const append = async (buf: Buffer): Promise<void> => {
    await appendFile(logPath, buf)
  }
  child.stdout?.on('data', (buf: Buffer) => void append(buf))
  child.stderr?.on('data', (buf: Buffer) => void append(buf))
  child.on('close', (code, signal) => {
    task.exitCode = code
    task.signal = signal
  })
  child.unref()
  return task
}

export async function readBackgroundShell(params: {
  taskId: string
  offset?: number
  block?: boolean
  timeoutMs?: number
}): Promise<{ content: string; nextOffset: number; done: boolean }> {
  const task = tasks.get(params.taskId)
  if (!task) throw new Error(`unknown background task: ${params.taskId}`)
  if (params.block && task.exitCode === undefined && task.signal === undefined) {
    await waitForTask(task, params.timeoutMs ?? 30_000)
  }
  const start = params.offset ?? 0
  const buf = await readFile(task.logPath)
  const slice = buf.subarray(Math.min(start, buf.length))
  return {
    content: slice.toString('utf8'),
    nextOffset: buf.length,
    done: task.exitCode !== undefined || task.signal !== undefined,
  }
}

export async function killBackgroundShell(taskId: string): Promise<boolean> {
  const task = tasks.get(taskId)
  if (!task) throw new Error(`unknown background task: ${taskId}`)
  if (task.exitCode !== undefined || task.signal !== undefined) return false
  return task.child.kill('SIGTERM')
}

async function waitForTask(task: BackgroundTask, timeoutMs: number): Promise<void> {
  if (task.exitCode !== undefined || task.signal !== undefined) return
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
