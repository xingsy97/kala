// Terminal-Bench 2.1 task-tree resolver.
//
// Official Terminal-Bench 2.1 (harbor-framework) ships each task as a
// directory:
//   <task>/task.yaml            — metadata incl. the `instruction` field
//   <task>/tests/               — verifier assets
//   <task>/run-tests.sh         — (or tests/run-tests.sh) the test entrypoint
//
// Our trial engine (terminal-bench.ts) is dataset-agnostic and consumes a
// normalized TerminalBenchTask { taskId, instruction, testScript, parser }.
// This resolver bridges an on-disk 2.1 task tree into that model so the same
// generic runner can execute official 2.1 tasks. Docker sandboxing for a task
// is expressed inside its own run-tests.sh (harbor tasks build/run their own
// container), so no benchmark-owned container naming is introduced here.

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { registerSweBenchRun } from '../core/run-registry.js'
import { terminalBenchRunLayout } from './terminal-bench.js'
import type { TerminalBenchParserName, TerminalBenchTask } from './terminal-bench.js'

export type ResolveTerminalBench21TaskTreeInput = {
  /** Directory containing one subdirectory per task (each with task.yaml). */
  datasetDir: string
  taskIds?: readonly string[]
  limit?: number
}

// Resolve official 2.1 task directories into normalized TerminalBenchTasks.
// A directory qualifies when it has task.yaml plus a runnable test entrypoint
// (run-tests.sh or tests/run-tests.sh).
export async function resolveTerminalBench21TaskTree(
  input: ResolveTerminalBench21TaskTreeInput,
): Promise<TerminalBenchTask[]> {
  const entries = await readdir(input.datasetDir, { withFileTypes: true })
  const wanted = input.taskIds && input.taskIds.length > 0 ? new Set(input.taskIds) : undefined
  const out: TerminalBenchTask[] = []
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskId = entry.name
    if (wanted && !wanted.has(taskId)) continue
    const taskDir = join(input.datasetDir, taskId)
    const taskYaml = join(taskDir, 'task.yaml')
    if (!existsSync(taskYaml)) continue
    const testEntry = findTestEntry(taskDir)
    if (!testEntry) continue
    const yaml = await readFile(taskYaml, 'utf8')
    const instruction = extractYamlBlock(yaml, 'instruction') ?? extractYamlScalar(yaml, 'instruction') ?? ''
    if (instruction.trim().length === 0) continue
    const parser: TerminalBenchParserName = /pytest/i.test(yaml) ? 'pytest' : 'exit-code'
    const timeoutSec = extractYamlNumber(yaml, 'max_test_timeout_sec')
      ?? extractYamlNumber(yaml, 'test_timeout_sec')
      ?? extractYamlNumber(yaml, 'timeout_sec')
    // The testScript runs the task's own entrypoint from the task directory.
    const testScript = `cd ${shellQuote(taskDir)} && bash ${shellQuote(testEntry)}`
    out.push({
      taskId,
      instruction,
      testScript,
      parser,
      ...(timeoutSec ? { timeoutSec } : {}),
    })
    if (typeof input.limit === 'number' && out.length >= input.limit) break
  }
  return out
}

function findTestEntry(taskDir: string): string | undefined {
  const candidates = [
    join(taskDir, 'run-tests.sh'),
    join(taskDir, 'tests', 'run-tests.sh'),
    join(taskDir, 'tests', 'test.sh'),
  ]
  return candidates.find((path) => existsSync(path))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// --- minimal YAML readers (dependency-free, sufficient for task.yaml) -----

// A block scalar: `instruction: |` followed by an indented body.
function extractYamlBlock(yaml: string, key: string): string | undefined {
  const re = new RegExp(`(^|\\n)${escapeRe(key)}:\\s*[|>][-+]?\\s*\\n([\\s\\S]*?)(?=\\n\\S|$)`)
  const m = re.exec(yaml)
  if (!m) return undefined
  const body = m[2] ?? ''
  const lines = body.split('\n')
  const indent = lines.find((l) => l.trim().length > 0)?.match(/^(\s*)/)?.[1]?.length ?? 0
  return lines.map((l) => l.slice(indent)).join('\n').replace(/\n+$/, '')
}

// A single-line scalar: `instruction: "text"` or `instruction: text`.
function extractYamlScalar(yaml: string, key: string): string | undefined {
  const m = new RegExp(`(^|\\n)${escapeRe(key)}:\\s*(?!$)(?![|>])("([^"]*)"|'([^']*)'|([^\\n]+))`).exec(yaml)
  if (!m) return undefined
  return (m[3] ?? m[4] ?? m[5] ?? '').trim()
}

function extractYamlNumber(yaml: string, key: string): number | undefined {
  const m = new RegExp(`(^|\\n)\\s*${escapeRe(key)}:\\s*([0-9]+(?:\\.[0-9]+)?)`).exec(yaml)
  return m ? Number(m[2]) : undefined
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- Real 2.1 Docker trial ------------------------------------------------
//
// Runs a task through its official Docker harness with strict, run-scoped
// isolation. Every image/container is named `ak-eval-tb21-<runId>-<taskId>`,
// containers use `--rm`, and only the run's own prefixed image is removed —
// pre-existing docker resources are never touched.
//
// Lifecycle mirrors the upstream harness: build the task Dockerfile → start a
// container → (optionally) apply the agent solution into /app → run
// run-tests.sh with TEST_DIR pointing at the copied tests → parse pytest.

export type TerminalBench21DockerTrialResult = {
  taskId: string
  status: 'resolved' | 'unresolved' | 'errored'
  buildExitCode: number | null
  testExitCode: number | null
  timedOut: boolean
  passed: boolean
  durationMs: number
  stdoutTail: string
  stderrTail: string
  errorMessage?: string
}

export type RunTerminalBench21DockerTrialInput = {
  taskDir: string
  taskId: string
  runId: string
  /**
   * How the agent's work reaches /app. `solution` applies the task's reference
   * solution.sh (a genuine end-to-end harness check that the task+verifier are
   * wired correctly). `none` runs the verifier against the empty task image.
   */
  agent?: 'solution' | 'none'
  timeoutMs?: number
}

const TB21_TAIL = 4000

export async function runTerminalBench21DockerTrial(
  input: RunTerminalBench21DockerTrialInput,
): Promise<TerminalBench21DockerTrialResult> {
  const startedAt = Date.now()
  const safeRun = tb21Sanitize(input.runId)
  const safeTask = tb21Sanitize(input.taskId)
  const imageTag = `ak-eval-tb21-${safeRun}-${safeTask}:trial`
  const containerName = `ak-eval-tb21-${safeRun}-${safeTask}`
  const timeoutMs = input.timeoutMs ?? 20 * 60_000
  const testEntry = ['run-tests.sh', join('tests', 'run-tests.sh'), join('tests', 'test.sh')]
    .map((rel) => join(input.taskDir, rel))
    .find((p) => existsSync(p))
  if (!testEntry) {
    return errResult(input.taskId, startedAt, 'no run-tests.sh entrypoint found')
  }

  // 1) Build the task image.
  const build = await tb21Docker([
    'build', '--tag', imageTag, '--file', join(input.taskDir, 'Dockerfile'), input.taskDir,
  ], timeoutMs)
  if (build.exitCode !== 0) {
    await tb21RemoveImage(imageTag)
    return { ...errResult(input.taskId, startedAt, `docker build failed (exit ${build.exitCode})`), buildExitCode: build.exitCode, stderrTail: tb21Tail(build.stderr) }
  }

  // 2) Run the container: apply solution (agent), then run the verifier with
  // TEST_DIR set to the copied tests directory. The whole thing is one
  // `docker run --rm` so nothing lingers.
  const applyAgent = input.agent === 'solution'
    ? 'if [ -f /verifier/solution.sh ]; then bash /verifier/solution.sh; fi;'
    : ''
  const script = [
    'set -e',
    'mkdir -p /app /verifier /tests',
    'cp -r /mnt/task/* /verifier/ 2>/dev/null || true',
    'cp -r /verifier/tests/* /tests/ 2>/dev/null || true',
    'cd /app',
    applyAgent,
    'export TEST_DIR=/tests',
    'bash /verifier/run-tests.sh',
  ].filter(Boolean).join('\n')
  const run = await tb21Docker([
    'run', '--rm', '--name', containerName,
    // SECURITY hardening. Terminal-Bench 2.1 run-tests.sh legitimately needs
    // network (apt/uv installs) and file operations, so we keep networking and
    // baseline file caps, cap resources, forbid privilege escalation, and drop
    // only the dangerous capabilities.
    '--cpus', '4', '--memory', '8g', '--pids-limit', '2048',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'NET_RAW', '--cap-drop', 'SYS_ADMIN', '--cap-drop', 'SYS_PTRACE',
    '--cap-drop', 'SYS_MODULE', '--cap-drop', 'MKNOD',
    '-v', `${input.taskDir}:/mnt/task:ro`,
    imageTag,
    'bash', '-lc', script,
  ], timeoutMs)

  await tb21RemoveImage(imageTag)

  // 3) Parse pytest outcome from combined output.
  const combined = `${run.stdout}\n${run.stderr}`
  const hasFailed = /\b\d+ failed\b/i.test(combined) || (/\berror\b/i.test(combined) && run.exitCode !== 0)
  const hasPassed = /\b\d+ passed\b/i.test(combined)
  const passed = run.exitCode === 0 && !run.timedOut && hasPassed && !hasFailed
  const status: TerminalBench21DockerTrialResult['status'] = run.timedOut
    ? 'errored'
    : passed
      ? 'resolved'
      : 'unresolved'
  return {
    taskId: input.taskId,
    status,
    buildExitCode: build.exitCode,
    testExitCode: run.exitCode,
    timedOut: run.timedOut,
    passed,
    durationMs: Date.now() - startedAt,
    stdoutTail: tb21Tail(run.stdout),
    stderrTail: tb21Tail(run.stderr),
  }
}

function errResult(taskId: string, startedAt: number, message: string): TerminalBench21DockerTrialResult {
  return {
    taskId,
    status: 'errored',
    buildExitCode: null,
    testExitCode: null,
    timedOut: false,
    passed: false,
    durationMs: Date.now() - startedAt,
    stdoutTail: '',
    stderrTail: '',
    errorMessage: message,
  }
}

function tb21Sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 48)
}

function tb21Tail(value: string): string {
  return value.length <= TB21_TAIL ? value : value.slice(-TB21_TAIL)
}

async function tb21RemoveImage(imageTag: string): Promise<void> {
  if (!imageTag.startsWith('ak-eval-tb21-')) return
  try {
    await tb21Docker(['image', 'rm', '-f', imageTag], 60_000)
  } catch {
    // best-effort
  }
}

async function tb21Docker(
  args: readonly string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      try {
        if (process.platform === 'win32') child.kill('SIGTERM')
        else if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already exited
      }
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (c) => { stdout += String(c) })
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: stderr + String(err), timedOut })
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    })
  })
}

// --- Batch run over a real 2.1 dataset directory --------------------------

export type RunTerminalBench21RunInput = {
  rootDir: string
  runId: string
  /** Directory of official 2.1 task subdirectories. */
  datasetDir: string
  dataset?: string
  model?: string
  taskIds?: readonly string[]
  /** 'solution' applies each task's reference solution; 'none' runs empty. */
  agent?: 'solution' | 'none'
  limit?: number
  timeoutMs?: number
}

export type TerminalBench21RunSummary = {
  runId: string
  total: number
  resolved: number
  unresolved: number
  errored: number
  accuracy: number
  durationMs: number
}

// Sequential by design: each trial builds and runs a Docker container, so
// overlapping builds would thrash the shared host that runs unrelated work.
export async function runTerminalBench21Run(
  input: RunTerminalBench21RunInput,
): Promise<{ summary: TerminalBench21RunSummary; results: readonly TerminalBench21DockerTrialResult[] }> {
  const layout = terminalBenchRunLayout(input.rootDir, input.runId)
  await mkdir(layout.rootDir, { recursive: true })
  await mkdir(layout.trialsDir, { recursive: true })

  const entries = await readdir(input.datasetDir, { withFileTypes: true })
  const wanted = input.taskIds && input.taskIds.length > 0 ? new Set(input.taskIds) : undefined
  const taskDirs: Array<{ taskId: string; taskDir: string }> = []
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (wanted && !wanted.has(entry.name)) continue
    const taskDir = join(input.datasetDir, entry.name)
    if (!existsSync(join(taskDir, 'Dockerfile'))) continue
    if (!['run-tests.sh', join('tests', 'run-tests.sh'), join('tests', 'test.sh')].some((r) => existsSync(join(taskDir, r)))) continue
    taskDirs.push({ taskId: entry.name, taskDir })
    if (typeof input.limit === 'number' && taskDirs.length >= input.limit) break
  }

  const startedAtMs = Date.now()
  const results: TerminalBench21DockerTrialResult[] = []
  let resolved = 0
  let unresolved = 0
  let errored = 0
  for (const { taskId, taskDir } of taskDirs) {
    const result = await runTerminalBench21DockerTrial({
      taskDir,
      taskId,
      runId: input.runId,
      agent: input.agent ?? 'solution',
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    })
    results.push(result)
    await writeFile(join(layout.trialsDir, `${taskId}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    if (result.status === 'resolved') resolved += 1
    else if (result.status === 'unresolved') unresolved += 1
    else errored += 1
  }
  await writeFile(layout.resultsJsonl, results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''), 'utf8')

  const summary: TerminalBench21RunSummary = {
    runId: input.runId,
    total: results.length,
    resolved,
    unresolved,
    errored,
    accuracy: results.length === 0 ? 0 : resolved / results.length,
    durationMs: Date.now() - startedAtMs,
  }
  await writeFile(layout.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  await registerSweBenchRun({
    rootDir: input.rootDir,
    runId: input.runId,
    kind: 'terminal-bench',
    dataset: input.dataset ?? 'terminal-bench/2.1',
    model: input.model ?? 'unspecified',
    runDir: layout.rootDir,
    selectedCount: results.length,
    maxWorkers: 1,
    shardCount: 1,
  })

  return { summary, results }
}
