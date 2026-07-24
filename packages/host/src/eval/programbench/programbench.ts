// ProgramBench BenchmarkAdapter runner (parallel to terminal-bench.ts / swebench.ts).
//
// Semantic contract: a ProgramBench trial is `resolved` when the reconstructed
// workspace satisfies the submission contract AND `./compile.sh` produces a
// fresh top-level `./executable` (compile probe `passed`). Any run where the
// agent command fails or the harness cannot evaluate maps to `errored`; a
// workspace that builds nothing / fails the compile probe maps to `unresolved`.
//
// Docker isolation: the compile probe (runProgramBenchCompileProbe) runs the
// task's compile.sh inside `docker run --rm --network none` when a per-task
// image is provided, otherwise on the host. All eval-created containers use
// `docker run --rm` and are never named to collide with pre-existing ones.
//
// This runner deliberately reuses the ProgramBench primitives that already
// exist (compile probe + submission contract) rather than duplicating a new
// trial engine — see docs/meta/principles.md D2.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { registerSweBenchRun } from '../core/run-registry.js'
import { runProgramBenchCompileProbe } from './programbench-compile.js'
import { inspectProgramBenchSubmissionContract } from './programbench-contract.js'

export type ProgramBenchTask = {
  instanceId: string
  /** Absolute path to the task workspace (already prepared with reference material). */
  workspaceRoot: string
  /** Optional per-task docker image used to sandbox compile.sh. */
  dockerImage?: string | null
  /** Compile timeout in seconds (defaults applied by the runner). */
  timeoutSec?: number
  repository?: string
  language?: string
}

export type ProgramBenchTrialResult = {
  instanceId: string
  status: 'resolved' | 'unresolved' | 'errored'
  contractSatisfied: boolean
  compileStatus: 'passed' | 'failed' | 'skipped' | 'timeout' | 'error'
  reasonCodes: readonly string[]
  agentExitCode: number | null
  agentTimedOut: boolean
  durationMs: number
  compileStdout: string
  compileStderr: string
  errorMessage?: string
}

export type ProgramBenchRunSummary = {
  runId: string
  total: number
  resolved: number
  unresolved: number
  errored: number
  accuracy: number
  durationMs: number
}

export type ProgramBenchRunLayout = {
  runId: string
  rootDir: string
  tasksJsonl: string
  resultsJsonl: string
  progressPath: string
  summaryPath: string
  trialsDir: string
}

export function programBenchRunLayout(rootDir: string, runId: string): ProgramBenchRunLayout {
  const root = join(rootDir, 'program-bench', 'runs', runId)
  return {
    runId,
    rootDir: root,
    tasksJsonl: join(root, 'tasks.jsonl'),
    resultsJsonl: join(root, 'results.jsonl'),
    progressPath: join(root, 'progress.json'),
    summaryPath: join(root, 'summary.json'),
    trialsDir: join(root, 'trials'),
  }
}

export type ResolveProgramBenchTasksInput = {
  tasksJsonlPath?: string
  inlineContent?: string
  instanceIds?: readonly string[]
  limit?: number
}

// Accepts a JSONL manifest (or inline content) of ProgramBench task rows. Each
// row must carry an `instanceId` and a `workspaceRoot`; the rest is optional.
export async function resolveProgramBenchTasks(
  input: ResolveProgramBenchTasksInput,
): Promise<ProgramBenchTask[]> {
  let raw: string
  if (input.inlineContent && input.inlineContent.trim().length > 0) {
    raw = input.inlineContent
  } else if (input.tasksJsonlPath) {
    raw = await readFile(input.tasksJsonlPath, 'utf8')
  } else {
    throw new Error('resolveProgramBenchTasks requires tasksJsonlPath or inlineContent')
  }
  const wanted = input.instanceIds && input.instanceIds.length > 0 ? new Set(input.instanceIds) : undefined
  const out: ProgramBenchTask[] = []
  for (const [i, line] of raw.split('\n').entries()) {
    if (line.trim().length === 0) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch (err) {
      throw new Error(`ProgramBench task line ${i + 1} is not JSON: ${(err as Error).message}`)
    }
    const instanceId = typeof parsed.instanceId === 'string'
      ? parsed.instanceId
      : typeof parsed.instance_id === 'string'
        ? parsed.instance_id
        : undefined
    const workspaceRoot = typeof parsed.workspaceRoot === 'string'
      ? parsed.workspaceRoot
      : typeof parsed.workspace_root === 'string'
        ? parsed.workspace_root
        : undefined
    if (!instanceId) throw new Error(`ProgramBench task line ${i + 1} missing instanceId`)
    if (!workspaceRoot) throw new Error(`ProgramBench task ${instanceId} missing workspaceRoot`)
    if (wanted && !wanted.has(instanceId)) continue
    const dockerImage = typeof parsed.dockerImage === 'string'
      ? parsed.dockerImage
      : typeof parsed.docker_image === 'string'
        ? parsed.docker_image
        : undefined
    const timeoutSec = typeof parsed.timeoutSec === 'number' && parsed.timeoutSec > 0
      ? parsed.timeoutSec
      : typeof parsed.timeout_sec === 'number' && parsed.timeout_sec > 0
        ? parsed.timeout_sec
        : undefined
    out.push({
      instanceId,
      workspaceRoot,
      ...(dockerImage ? { dockerImage } : {}),
      ...(timeoutSec ? { timeoutSec } : {}),
      ...(typeof parsed.repository === 'string' ? { repository: parsed.repository } : {}),
      ...(typeof parsed.language === 'string' ? { language: parsed.language } : {}),
    })
    if (typeof input.limit === 'number' && out.length >= input.limit) break
  }
  return out
}

export type RunProgramBenchTrialInput = {
  task: ProgramBenchTask
  /**
   * Command that reconstructs the workspace (the agent). Runs with the task
   * workspace as cwd. `true` (a no-op) is the default so the harness can be
   * exercised end-to-end without an agent, scoring the pre-existing workspace.
   */
  agentCommand?: string
  timeoutMs?: number
  /**
   * SECURITY: ProgramBench tasks are untrusted (dataset-supplied compile.sh and
   * agent commands). By default this runner refuses to execute them directly on
   * the host: the compile step requires a per-task docker image, and a
   * non-trivial agentCommand requires an explicit opt-in. Set this to true ONLY
   * when the caller has already sandboxed the host (e.g. the whole process runs
   * inside a disposable VM/container). Defaults to false.
   */
  allowHostExecution?: boolean
}

const DEFAULT_COMPILE_TIMEOUT_MS = 10 * 60_000

export async function runProgramBenchTrial(
  input: RunProgramBenchTrialInput,
): Promise<ProgramBenchTrialResult> {
  const startedAt = Date.now()
  const task = input.task
  const agentTimeoutMs = input.timeoutMs ?? (task.timeoutSec ? task.timeoutSec * 1000 : undefined)
  const allowHostExecution = input.allowHostExecution === true

  // Optional agent step. When omitted (or `true`) we score the workspace as-is.
  let agentExitCode: number | null = 0
  let agentTimedOut = false
  const agentCommand = input.agentCommand ?? 'true'
  if (agentCommand.trim() !== 'true') {
    // SECURITY: a real agent command is untrusted dataset-adjacent input. We
    // will not run it directly on the host unless the caller explicitly says
    // the host is already sandboxed.
    if (!allowHostExecution) {
      return {
        instanceId: task.instanceId,
        status: 'errored',
        contractSatisfied: false,
        compileStatus: 'skipped',
        reasonCodes: ['host_execution_blocked'],
        agentExitCode: null,
        agentTimedOut: false,
        durationMs: Date.now() - startedAt,
        compileStdout: '',
        compileStderr: '',
        errorMessage: 'refusing to run an untrusted agentCommand on the host; provide a sandbox or set allowHostExecution',
      }
    }
    const agent = await runShell(agentCommand, {
      cwd: task.workspaceRoot,
      ...(agentTimeoutMs ? { timeoutMs: agentTimeoutMs } : {}),
      env: {
        AGENT_KERNEL_PB_INSTANCE_ID: task.instanceId,
        AGENT_KERNEL_PB_WORKSPACE: task.workspaceRoot,
      },
    })
    agentExitCode = agent.exitCode
    agentTimedOut = agent.timedOut
    if (agentTimedOut || (agentExitCode !== null && agentExitCode !== 0)) {
      return {
        instanceId: task.instanceId,
        status: 'errored',
        contractSatisfied: false,
        compileStatus: 'skipped',
        reasonCodes: [agentTimedOut ? 'agent_timeout' : 'agent_failed'],
        agentExitCode,
        agentTimedOut,
        durationMs: Date.now() - startedAt,
        compileStdout: '',
        compileStderr: '',
        errorMessage: agentTimedOut ? 'agent timed out' : `agent exit ${agentExitCode}`,
      }
    }
  }

  // SECURITY: the compile step runs the task's compile.sh. Without a per-task
  // docker image the compile probe would fall back to running it directly on
  // the host. Refuse that unless the caller opted into host execution.
  if (!task.dockerImage && !allowHostExecution) {
    return {
      instanceId: task.instanceId,
      status: 'errored',
      contractSatisfied: false,
      compileStatus: 'skipped',
      reasonCodes: ['host_compile_blocked'],
      agentExitCode,
      agentTimedOut,
      durationMs: Date.now() - startedAt,
      compileStdout: '',
      compileStderr: '',
      errorMessage: 'refusing to compile untrusted workspace on the host; provide task.dockerImage or set allowHostExecution',
    }
  }

  const contract = await inspectProgramBenchSubmissionContract(task.workspaceRoot)
  const compile = await runProgramBenchCompileProbe({
    workspaceRoot: task.workspaceRoot,
    dockerImage: task.dockerImage ?? null,
    timeoutMs: agentTimeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS,
  })

  const executableBuilt = existsSync(join(task.workspaceRoot, 'executable'))
  const resolved = contract.ok && compile.status === 'passed' && executableBuilt
  const status: ProgramBenchTrialResult['status'] = compile.status === 'error'
    ? 'errored'
    : resolved
      ? 'resolved'
      : 'unresolved'
  const reasonCodes = Array.from(new Set([
    ...(contract.ok ? [] : contract.reason_codes),
    ...compile.reason_codes,
    ...(executableBuilt ? [] : ['executable_missing']),
  ]))
  return {
    instanceId: task.instanceId,
    status,
    contractSatisfied: contract.ok,
    compileStatus: compile.status,
    reasonCodes,
    agentExitCode,
    agentTimedOut,
    durationMs: Date.now() - startedAt,
    compileStdout: compile.stdout,
    compileStderr: compile.stderr,
  }
}

export type RunProgramBenchRunInput = {
  rootDir: string
  runId: string
  dataset?: string
  model?: string
  tasksJsonl?: string
  inlineTasksContent?: string
  instanceIds?: readonly string[]
  agentCommand?: string
  limit?: number
  maxWorkers?: number
  timeoutMs?: number
  /** SECURITY: see RunProgramBenchTrialInput.allowHostExecution. */
  allowHostExecution?: boolean
}

export type ProgramBenchRunProgress = {
  schemaVersion: 1
  runId: string
  status: 'running' | 'completed' | 'failed'
  total: number
  completed: number
  resolved: number
  unresolved: number
  errored: number
  currentTask?: string
  startedAt: string
  updatedAt: string
  lastUpdatedAt: string
  finishedAt?: string
}

export async function runProgramBenchRun(
  input: RunProgramBenchRunInput,
): Promise<{ layout: ProgramBenchRunLayout; summary: ProgramBenchRunSummary; results: readonly ProgramBenchTrialResult[] }> {
  const layout = programBenchRunLayout(input.rootDir, input.runId)
  await mkdir(layout.rootDir, { recursive: true })
  await mkdir(layout.trialsDir, { recursive: true })

  const tasks = await resolveProgramBenchTasks({
    ...(input.tasksJsonl ? { tasksJsonlPath: input.tasksJsonl } : {}),
    ...(input.inlineTasksContent ? { inlineContent: input.inlineTasksContent } : {}),
    ...(input.instanceIds ? { instanceIds: input.instanceIds } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  })
  await writeFile(layout.tasksJsonl, tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''), 'utf8')

  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()
  const progress: ProgramBenchRunProgress = {
    schemaVersion: 1,
    runId: input.runId,
    status: 'running',
    total: tasks.length,
    completed: 0,
    resolved: 0,
    unresolved: 0,
    errored: 0,
    startedAt,
    updatedAt: startedAt,
    lastUpdatedAt: startedAt,
  }
  await writeProgress(layout.progressPath, progress)

  const results: ProgramBenchTrialResult[] = []
  const width = Math.max(1, Math.floor(input.maxWorkers ?? 1))
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor
      cursor += 1
      const task = tasks[index]
      if (!task) return
      progress.currentTask = task.instanceId
      progress.lastUpdatedAt = new Date().toISOString()
      progress.updatedAt = progress.lastUpdatedAt
      await writeProgress(layout.progressPath, progress)
      const result = await runProgramBenchTrial({
        task,
        ...(input.agentCommand ? { agentCommand: input.agentCommand } : {}),
        ...(input.allowHostExecution ? { allowHostExecution: true } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      })
      results.push(result)
      await writeFile(join(layout.trialsDir, `${task.instanceId}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      progress.completed += 1
      if (result.status === 'resolved') progress.resolved += 1
      else if (result.status === 'unresolved') progress.unresolved += 1
      else progress.errored += 1
      progress.lastUpdatedAt = new Date().toISOString()
      progress.updatedAt = progress.lastUpdatedAt
      await writeProgress(layout.progressPath, progress)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, Math.max(1, tasks.length)) }, () => worker()))

  const order = new Map(tasks.map((task, index) => [task.instanceId, index]))
  const orderedResults = [...results].sort(
    (a, b) => (order.get(a.instanceId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.instanceId) ?? Number.MAX_SAFE_INTEGER),
  )
  await writeFile(layout.resultsJsonl, orderedResults.map((r) => JSON.stringify(r)).join('\n') + (orderedResults.length ? '\n' : ''), 'utf8')

  const summary: ProgramBenchRunSummary = {
    runId: input.runId,
    total: orderedResults.length,
    resolved: progress.resolved,
    unresolved: progress.unresolved,
    errored: progress.errored,
    accuracy: orderedResults.length === 0 ? 0 : progress.resolved / orderedResults.length,
    durationMs: Date.now() - startedAtMs,
  }
  await writeFile(layout.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  const finishedAt = new Date().toISOString()
  progress.status = progress.errored > 0 && progress.resolved === 0 && progress.unresolved === 0 ? 'failed' : 'completed'
  progress.finishedAt = finishedAt
  progress.updatedAt = finishedAt
  progress.lastUpdatedAt = finishedAt
  delete progress.currentTask
  await writeProgress(layout.progressPath, progress)

  await registerSweBenchRun({
    rootDir: input.rootDir,
    runId: input.runId,
    kind: 'program-bench',
    dataset: input.dataset ?? 'program-bench/local',
    model: input.model ?? 'unspecified',
    runDir: layout.rootDir,
    selectedCount: tasks.length,
    maxWorkers: width,
    shardCount: 1,
  })

  return { layout, summary, results: orderedResults }
}

async function writeProgress(path: string, progress: ProgramBenchRunProgress): Promise<void> {
  await writeFile(path, `${JSON.stringify(progress, null, 2)}\n`, 'utf8')
}

export type ImportProgramBenchResultsInput = {
  rootDir: string
  runId: string
}

export async function importProgramBenchResults(
  input: ImportProgramBenchResultsInput,
): Promise<ProgramBenchRunSummary> {
  const layout = programBenchRunLayout(input.rootDir, input.runId)
  if (!existsSync(layout.resultsJsonl)) {
    throw new Error(`ProgramBench results not found for run ${input.runId}`)
  }
  const raw = await readFile(layout.resultsJsonl, 'utf8')
  let total = 0
  let resolved = 0
  let unresolved = 0
  let errored = 0
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const row = JSON.parse(line) as ProgramBenchTrialResult
    total += 1
    if (row.status === 'resolved') resolved += 1
    else if (row.status === 'unresolved') unresolved += 1
    else errored += 1
  }
  const summary: ProgramBenchRunSummary = {
    runId: input.runId,
    total,
    resolved,
    unresolved,
    errored,
    accuracy: total === 0 ? 0 : resolved / total,
    durationMs: 0,
  }
  await writeFile(layout.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return summary
}

// Local process runner (mirrors terminal-bench.ts runShell). Kept private so
// the trial engine stays self-contained.
async function runShell(command: string, options: {
  cwd: string
  timeoutMs?: number
  env?: Record<string, string>
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn('bash', ['-lc', command], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, ...(options.env ?? {}) },
    })
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return
          timedOut = true
          try {
            if (process.platform === 'win32') child.kill('SIGTERM')
            else if (child.pid) process.kill(-child.pid, 'SIGKILL')
          } catch {
            // already exited
          }
        }, options.timeoutMs)
      : undefined
    timer?.unref?.()
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: stderr + String(err), timedOut })
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    })
  })
}
