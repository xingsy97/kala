// Terminal-Bench adapter (parallel to swebench.ts).
//
// Semantic contract: a trial is `resolved` ONLY when the task's testScript
// exits 0 AND every parsed unit reports pass. Any other outcome maps to
// `unresolved` (tests ran but did not all pass) or `errored` (agent or
// harness failure before tests could complete). See
// docs/evals/domain-knowledge/terminal-bench-evaluation.md for the source of truth.
//
// Scope for this iteration: run tasks defined by a local JSONL manifest
// (see resolveTerminalBenchTasks). Integration with the upstream
// `terminal-bench` Python CLI, Docker sandboxing, asciinema recording, and
// pluggable parsers is deferred to a follow-up (see task #78 for the
// BenchmarkAdapter interface extraction and #79 for dashboard wiring).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerSweBenchRun } from './run-registry.js'

export type TerminalBenchRunLayout = {
  runId: string
  rootDir: string
  tasksJsonl: string
  resultsJsonl: string
  progressPath: string
  summaryPath: string
  trialsDir: string
}

export function terminalBenchRunLayout(rootDir: string, runId: string): TerminalBenchRunLayout {
  const runRoot = join(rootDir, runId)
  return {
    runId,
    rootDir: runRoot,
    tasksJsonl: join(runRoot, 'tasks.jsonl'),
    resultsJsonl: join(runRoot, 'results.jsonl'),
    progressPath: join(runRoot, 'progress.json'),
    summaryPath: join(runRoot, 'summary.json'),
    trialsDir: join(runRoot, 'trials'),
  }
}

export type TerminalBenchParserName = 'exit-code' | 'pytest'

export type TerminalBenchTask = {
  taskId: string
  instruction: string
  testScript: string
  timeoutSec?: number
  parser?: TerminalBenchParserName
}

export type TerminalBenchTrialStatus = 'resolved' | 'unresolved' | 'errored'

export type TerminalBenchTrialResult = {
  taskId: string
  status: TerminalBenchTrialStatus
  parserOutput: {
    parser: TerminalBenchParserName
    allPassed: boolean
    details?: string
  }
  agentExitCode: number | null
  agentTimedOut: boolean
  testExitCode: number | null
  testTimedOut: boolean
  durationMs: number
  agentStdout: string
  agentStderr: string
  testStdout: string
  testStderr: string
  errorMessage?: string
}

export type ResolveTerminalBenchTasksInput = {
  dataset?: string
  tasksJsonlPath?: string
  inlineContent?: string
  taskIds?: readonly string[]
  limit?: number
}

// v1 accepts either a local JSONL path or inline content. Loading a real
// terminal-bench dataset (task.yaml + docker-compose + run-tests.sh trees)
// is deferred; see the module header comment.
export async function resolveTerminalBenchTasks(
  input: ResolveTerminalBenchTasksInput,
): Promise<TerminalBenchTask[]> {
  let raw: string
  if (input.inlineContent && input.inlineContent.trim().length > 0) {
    raw = input.inlineContent
  } else if (input.tasksJsonlPath) {
    raw = await readFile(input.tasksJsonlPath, 'utf8')
  } else {
    throw new Error('resolveTerminalBenchTasks requires tasksJsonlPath or inlineContent')
  }
  const wanted = input.taskIds && input.taskIds.length > 0 ? new Set(input.taskIds) : undefined
  const out: TerminalBenchTask[] = []
  for (const [i, line] of raw.split('\n').entries()) {
    if (line.trim().length === 0) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch (err) {
      throw new Error(`Terminal-Bench task line ${i + 1} is not JSON: ${(err as Error).message}`)
    }
    const taskId = typeof parsed.taskId === 'string' ? parsed.taskId : undefined
    const instruction = typeof parsed.instruction === 'string' ? parsed.instruction : undefined
    const testScript = typeof parsed.testScript === 'string' ? parsed.testScript : undefined
    if (!taskId) throw new Error(`Terminal-Bench task line ${i + 1} missing taskId`)
    if (!instruction) throw new Error(`Terminal-Bench task ${taskId} missing instruction`)
    if (!testScript) throw new Error(`Terminal-Bench task ${taskId} missing testScript`)
    if (wanted && !wanted.has(taskId)) continue
    const parser = parsed.parser === 'pytest' ? 'pytest' : 'exit-code'
    const timeoutSec = typeof parsed.timeoutSec === 'number' && parsed.timeoutSec > 0 ? parsed.timeoutSec : undefined
    out.push({
      taskId,
      instruction,
      testScript,
      ...(timeoutSec ? { timeoutSec } : {}),
      parser,
    })
    if (typeof input.limit === 'number' && out.length >= input.limit) break
  }
  return out
}

export type RunTerminalBenchTrialInput = {
  task: TerminalBenchTask
  agentCommand: string
  workDir?: string
  timeoutMs?: number
}

export async function runTerminalBenchTrial(
  input: RunTerminalBenchTrialInput,
): Promise<TerminalBenchTrialResult> {
  const startedAt = Date.now()
  const workDir = input.workDir ?? await mkdtemp(join(tmpdir(), `ak-tb-${input.task.taskId}-`))
  await mkdir(workDir, { recursive: true })
  const instructionFile = join(workDir, '.tb-instruction.txt')
  await writeFile(instructionFile, input.task.instruction, 'utf8')

  const agentTimeoutMs = input.timeoutMs ?? (input.task.timeoutSec ? input.task.timeoutSec * 1000 : undefined)
  const agent = await runShell(input.agentCommand, {
    cwd: workDir,
    ...(agentTimeoutMs ? { timeoutMs: agentTimeoutMs } : {}),
    env: {
      AGENT_KERNEL_TB_INSTRUCTION: input.task.instruction,
      AGENT_KERNEL_TB_INSTRUCTION_FILE: instructionFile,
      AGENT_KERNEL_TB_TASK_ID: input.task.taskId,
    },
  })

  if (agent.timedOut || (agent.exitCode !== null && agent.exitCode !== 0)) {
    return {
      taskId: input.task.taskId,
      status: 'errored',
      parserOutput: { parser: input.task.parser ?? 'exit-code', allPassed: false, details: 'agent did not complete cleanly' },
      agentExitCode: agent.exitCode,
      agentTimedOut: agent.timedOut,
      testExitCode: null,
      testTimedOut: false,
      durationMs: Date.now() - startedAt,
      agentStdout: agent.stdout,
      agentStderr: agent.stderr,
      testStdout: '',
      testStderr: '',
      errorMessage: agent.timedOut ? 'agent timed out' : `agent exit ${agent.exitCode}`,
    }
  }

  const testTimeoutMs = input.task.timeoutSec ? input.task.timeoutSec * 1000 : undefined
  const test = await runShell(input.task.testScript, {
    cwd: workDir,
    ...(testTimeoutMs ? { timeoutMs: testTimeoutMs } : {}),
  })

  const parser: TerminalBenchParserName = input.task.parser ?? 'exit-code'
  const parserOutput = parseTerminalBenchTestOutput(parser, test)
  // is_resolved requires BOTH: testScript exit 0 AND every parsed unit passed.
  const resolved = test.exitCode === 0 && !test.timedOut && parserOutput.allPassed
  return {
    taskId: input.task.taskId,
    status: resolved ? 'resolved' : 'unresolved',
    parserOutput,
    agentExitCode: agent.exitCode,
    agentTimedOut: agent.timedOut,
    testExitCode: test.exitCode,
    testTimedOut: test.timedOut,
    durationMs: Date.now() - startedAt,
    agentStdout: agent.stdout,
    agentStderr: agent.stderr,
    testStdout: test.stdout,
    testStderr: test.stderr,
  }
}

function parseTerminalBenchTestOutput(
  parser: TerminalBenchParserName,
  test: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean },
): TerminalBenchTrialResult['parserOutput'] {
  if (parser === 'pytest') {
    // pytest summary line "= X failed, Y passed" means at least one failure.
    const combined = `${test.stdout}\n${test.stderr}`
    const hasFailed = /\b\d+ failed\b/i.test(combined) || /\berror\b/i.test(combined) && test.exitCode !== 0
    const hasPassed = /\b\d+ passed\b/i.test(combined)
    return {
      parser,
      allPassed: test.exitCode === 0 && !test.timedOut && !hasFailed && hasPassed,
      ...(combined.trim() ? { details: combined.slice(0, 500) } : {}),
    }
  }
  return {
    parser,
    allPassed: test.exitCode === 0 && !test.timedOut,
    ...(test.stderr.trim() ? { details: test.stderr.slice(0, 500) } : {}),
  }
}

export type TerminalBenchRunProgress = {
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

export type RunTerminalBenchRunInput = {
  rootDir: string
  runId: string
  dataset?: string
  model?: string
  tasksJsonl?: string
  inlineTasksContent?: string
  agentCommand: string
  taskIds?: readonly string[]
  limit?: number
  maxWorkers?: number
  timeoutMs?: number
}

export type TerminalBenchRunSummary = {
  runId: string
  total: number
  resolved: number
  unresolved: number
  errored: number
  accuracy: number
  durationMs: number
}

export async function runTerminalBenchRun(
  input: RunTerminalBenchRunInput,
): Promise<{ layout: TerminalBenchRunLayout; summary: TerminalBenchRunSummary; results: readonly TerminalBenchTrialResult[] }> {
  const layout = terminalBenchRunLayout(input.rootDir, input.runId)
  await mkdir(layout.rootDir, { recursive: true })
  await mkdir(layout.trialsDir, { recursive: true })

  const tasks = await resolveTerminalBenchTasks({
    ...(input.tasksJsonl ? { tasksJsonlPath: input.tasksJsonl } : {}),
    ...(input.inlineTasksContent ? { inlineContent: input.inlineTasksContent } : {}),
    ...(input.taskIds ? { taskIds: input.taskIds } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  })
  await writeFile(layout.tasksJsonl, tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : ''), 'utf8')

  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()
  const progress: TerminalBenchRunProgress = {
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

  const results: TerminalBenchTrialResult[] = []
  const width = Math.max(1, Math.floor(input.maxWorkers ?? 1))
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor
      cursor += 1
      const task = tasks[index]
      if (!task) return
      progress.currentTask = task.taskId
      progress.lastUpdatedAt = new Date().toISOString()
      progress.updatedAt = progress.lastUpdatedAt
      await writeProgress(layout.progressPath, progress)
      const trialWorkDir = join(layout.rootDir, 'workspaces', task.taskId)
      await mkdir(trialWorkDir, { recursive: true })
      const result = await runTerminalBenchTrial({
        task,
        agentCommand: input.agentCommand,
        workDir: trialWorkDir,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      })
      results.push(result)
      await writeFile(join(layout.trialsDir, `${task.taskId}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
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

  const orderedResults = orderResults(results, tasks)
  await writeFile(layout.resultsJsonl, orderedResults.map((r) => JSON.stringify(r)).join('\n') + (orderedResults.length ? '\n' : ''), 'utf8')

  const summary: TerminalBenchRunSummary = {
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
  progress.status = progress.errored > 0 ? 'failed' : 'completed'
  progress.finishedAt = finishedAt
  progress.updatedAt = finishedAt
  progress.lastUpdatedAt = finishedAt
  delete progress.currentTask
  await writeProgress(layout.progressPath, progress)

  await registerSweBenchRun({
    rootDir: input.rootDir,
    runId: input.runId,
    kind: 'terminal-bench',
    dataset: input.dataset ?? 'terminal-bench/local',
    model: input.model ?? 'unspecified',
    runDir: layout.rootDir,
    selectedCount: tasks.length,
    maxWorkers: width,
    shardCount: 1,
  })

  return { layout, summary, results: orderedResults }
}

function orderResults(results: readonly TerminalBenchTrialResult[], tasks: readonly TerminalBenchTask[]): TerminalBenchTrialResult[] {
  const order = new Map(tasks.map((task, index) => [task.taskId, index]))
  return [...results].sort((a, b) => (order.get(a.taskId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.taskId) ?? Number.MAX_SAFE_INTEGER))
}

async function writeProgress(path: string, progress: TerminalBenchRunProgress): Promise<void> {
  await writeFile(path, `${JSON.stringify(progress, null, 2)}\n`, 'utf8')
}

export type ImportTerminalBenchResultsInput = {
  rootDir: string
  runId: string
}

export async function importTerminalBenchResults(
  input: ImportTerminalBenchResultsInput,
): Promise<TerminalBenchRunSummary> {
  const layout = terminalBenchRunLayout(input.rootDir, input.runId)
  if (!existsSync(layout.resultsJsonl)) {
    throw new Error(`Terminal-Bench results not found for run ${input.runId}`)
  }
  const raw = await readFile(layout.resultsJsonl, 'utf8')
  let total = 0
  let resolved = 0
  let unresolved = 0
  let errored = 0
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const row = JSON.parse(line) as TerminalBenchTrialResult
    total += 1
    if (row.status === 'resolved') resolved += 1
    else if (row.status === 'unresolved') unresolved += 1
    else errored += 1
  }
  const summary: TerminalBenchRunSummary = {
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

async function runShell(command: string, options: {
  cwd: string
  timeoutMs?: number
  env?: Record<string, string>
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolvePromise, reject) => {
    const isWin = process.platform === 'win32'
    const bin = isWin ? 'cmd.exe' : 'sh'
    const args = isWin ? ['/d', '/s', '/c', command] : ['-lc', command]
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
        }, options.timeoutMs)
      : undefined
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (exitCode) => {
      if (timer) clearTimeout(timer)
      resolvePromise({ exitCode, stdout, stderr, timedOut })
    })
  })
}
