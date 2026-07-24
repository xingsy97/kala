// SWE-Marathon BenchmarkAdapter runner (parallel to terminal-bench.ts).
//
// SWE-Marathon ships tasks in the Harbor format: each task directory has
//   task.toml            — metadata + [verifier]/[agent]/[environment] config
//   instruction.md       — the agent-facing problem statement
//   environment/Dockerfile — builds the task container
//   tests/test.sh        — the verifier; writes binary reward to
//                          /logs/verifier/reward.txt (0 or 1)
//
// A trial is `resolved` iff the verifier writes reward == 1. It is `errored`
// if the container build or verifier infra fails before a reward is produced,
// and `unresolved` when the verifier ran and produced reward 0.
//
// DOCKER ISOLATION (hard requirement — the host runs unrelated containers we
// must never touch): every image/container this runner creates is named with
// the run-scoped prefix `ak-eval-swemara-<runId>-<taskId>`; containers always
// use `docker run --rm`; on completion we remove ONLY the image we built for
// this task (matched by that exact prefix). We never prune, never touch
// resources outside our prefix.

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { registerSweBenchRun } from '../core/run-registry.js'

export type SweMarathonTask = {
  taskId: string
  /** Absolute path to the harbor task directory. */
  taskDir: string
  instruction: string
  verifierTimeoutSec?: number
  agentTimeoutSec?: number
  networkMode?: string
  difficulty?: string
  category?: string
}

export type SweMarathonTrialResult = {
  taskId: string
  status: 'resolved' | 'unresolved' | 'errored'
  reward: number | null
  buildExitCode: number | null
  verifierExitCode: number | null
  verifierTimedOut: boolean
  durationMs: number
  buildStderrTail: string
  verifierStdoutTail: string
  verifierStderrTail: string
  errorMessage?: string
}

export type SweMarathonRunSummary = {
  runId: string
  total: number
  resolved: number
  unresolved: number
  errored: number
  accuracy: number
  durationMs: number
}

export type SweMarathonRunLayout = {
  runId: string
  rootDir: string
  tasksJsonl: string
  resultsJsonl: string
  progressPath: string
  summaryPath: string
  trialsDir: string
}

export function sweMarathonRunLayout(rootDir: string, runId: string): SweMarathonRunLayout {
  const root = join(rootDir, 'swe-marathon', 'runs', runId)
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

export type ResolveSweMarathonTasksInput = {
  /** Root directory containing harbor task subdirectories (each with task.toml). */
  tasksDir: string
  taskIds?: readonly string[]
  limit?: number
}

// Resolve harbor task directories under tasksDir. A directory qualifies when it
// contains task.toml + instruction.md + environment/Dockerfile + tests/test.sh.
export async function resolveSweMarathonTasks(
  input: ResolveSweMarathonTasksInput,
): Promise<SweMarathonTask[]> {
  const entries = await readdir(input.tasksDir, { withFileTypes: true })
  const wanted = input.taskIds && input.taskIds.length > 0 ? new Set(input.taskIds) : undefined
  const out: SweMarathonTask[] = []
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskId = entry.name
    if (wanted && !wanted.has(taskId)) continue
    const taskDir = join(input.tasksDir, taskId)
    const tomlPath = join(taskDir, 'task.toml')
    const instructionPath = join(taskDir, 'instruction.md')
    const dockerfilePath = join(taskDir, 'environment', 'Dockerfile')
    const testShPath = join(taskDir, 'tests', 'test.sh')
    if (!existsSync(tomlPath) || !existsSync(instructionPath) || !existsSync(dockerfilePath) || !existsSync(testShPath)) {
      continue
    }
    const toml = await readFile(tomlPath, 'utf8')
    const instruction = await readFile(instructionPath, 'utf8')
    out.push({
      taskId,
      taskDir,
      instruction,
      ...(tomlNumber(toml, 'verifier', 'timeout_sec') !== undefined ? { verifierTimeoutSec: tomlNumber(toml, 'verifier', 'timeout_sec') } : {}),
      ...(tomlNumber(toml, 'agent', 'timeout_sec') !== undefined ? { agentTimeoutSec: tomlNumber(toml, 'agent', 'timeout_sec') } : {}),
      ...(tomlString(toml, 'environment', 'network_mode') ? { networkMode: tomlString(toml, 'environment', 'network_mode')! } : {}),
      ...(tomlString(toml, 'metadata', 'difficulty') ? { difficulty: tomlString(toml, 'metadata', 'difficulty')! } : {}),
      ...(tomlString(toml, 'metadata', 'category') ? { category: tomlString(toml, 'metadata', 'category')! } : {}),
    })
    if (typeof input.limit === 'number' && out.length >= input.limit) break
  }
  return out
}

export type RunSweMarathonTrialInput = {
  task: SweMarathonTask
  runId: string
  /** Directory holding the agent's solution workspace to mount at /app. */
  agentWorkspace?: string
  /** Optional cap on build+verify wall-clock (ms). Falls back to task.toml. */
  timeoutMs?: number
  /** Directory to collect /logs artifacts for this trial. */
  logsDir?: string
}

const TAIL = 4000

// Build the task image and run its verifier in an isolated, prefixed container.
export async function runSweMarathonTrial(
  input: RunSweMarathonTrialInput,
): Promise<SweMarathonTrialResult> {
  const startedAt = Date.now()
  const task = input.task
  const safeRun = sanitize(input.runId)
  const safeTask = sanitize(task.taskId)
  const imageTag = `ak-eval-swemara-${safeRun}-${safeTask}:trial`
  const containerName = `ak-eval-swemara-${safeRun}-${safeTask}`
  const verifierTimeoutMs = input.timeoutMs ?? (task.verifierTimeoutSec ? task.verifierTimeoutSec * 1000 : 30 * 60_000)

  // 1) Build the task image from environment/Dockerfile (prefixed tag).
  const build = await runProcess('docker', [
    'build', '--tag', imageTag, '--file', join(task.taskDir, 'environment', 'Dockerfile'),
    join(task.taskDir, 'environment'),
  ], { timeoutMs: verifierTimeoutMs })
  if (build.exitCode !== 0) {
    await removeImage(imageTag)
    return {
      taskId: task.taskId,
      status: 'errored',
      reward: null,
      buildExitCode: build.exitCode,
      verifierExitCode: null,
      verifierTimedOut: false,
      durationMs: Date.now() - startedAt,
      buildStderrTail: tail(build.stderr),
      verifierStdoutTail: '',
      verifierStderrTail: '',
      errorMessage: `docker build failed (exit ${build.exitCode})`,
    }
  }

  // 2) Run the verifier inside the isolated container. tests/ is copied in and
  // test.sh writes /logs/verifier/reward.txt. Network mode honours the task,
  // defaulting to `none` for safety when unspecified.
  const network = task.networkMode === 'public' ? 'bridge' : 'none'
  const args = [
    'run', '--rm', '--name', containerName,
    '--network', network,
    // SECURITY hardening for the untrusted verifier (tests/test.sh): cap
    // resources, forbid privilege escalation, and drop the dangerous Linux
    // capabilities while keeping the file-ownership caps the verifier needs to
    // write its /logs artifacts across the bind mount.
    '--cpus', '4', '--memory', '8g', '--pids-limit', '2048',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'NET_RAW', '--cap-drop', 'SYS_ADMIN', '--cap-drop', 'SYS_PTRACE',
    '--cap-drop', 'SYS_MODULE', '--cap-drop', 'MKNOD',
    '-v', `${task.taskDir}/tests:/tests:ro`,
    ...(input.agentWorkspace ? ['-v', `${input.agentWorkspace}:/app`] : []),
    ...(input.logsDir ? ['-v', `${input.logsDir}:/logs`] : []),
    imageTag,
    'bash', '-lc',
    'mkdir -p /logs/verifier && cp -r /tests/* /app/tests/ 2>/dev/null; cd /app && bash /tests/test.sh; echo "reward=$(cat /logs/verifier/reward.txt 2>/dev/null)"',
  ]
  const verify = await runProcess('docker', args, { timeoutMs: verifierTimeoutMs })

  // 3) Read reward from the collected logs (bind mount) or from stdout marker.
  let reward: number | null = null
  if (input.logsDir) {
    const rewardPath = join(input.logsDir, 'verifier', 'reward.txt')
    if (existsSync(rewardPath)) {
      const raw = (await readFile(rewardPath, 'utf8')).trim()
      const parsed = Number(raw)
      if (!Number.isNaN(parsed)) reward = parsed
    }
  }
  if (reward === null) {
    const m = /reward=(\d+(?:\.\d+)?)/.exec(verify.stdout)
    if (m) reward = Number(m[1])
  }

  await removeImage(imageTag)

  const status: SweMarathonTrialResult['status'] = reward === null
    ? 'errored'
    : reward >= 1
      ? 'resolved'
      : 'unresolved'
  return {
    taskId: task.taskId,
    status,
    reward,
    buildExitCode: build.exitCode,
    verifierExitCode: verify.exitCode,
    verifierTimedOut: verify.timedOut,
    durationMs: Date.now() - startedAt,
    buildStderrTail: tail(build.stderr),
    verifierStdoutTail: tail(verify.stdout),
    verifierStderrTail: tail(verify.stderr),
    ...(reward === null ? { errorMessage: 'verifier produced no reward' } : {}),
  }
}

export type RunSweMarathonRunInput = {
  rootDir: string
  runId: string
  tasksDir: string
  dataset?: string
  model?: string
  taskIds?: readonly string[]
  agentWorkspaceByTask?: Record<string, string>
  limit?: number
  timeoutMs?: number
}

export type SweMarathonRunProgress = {
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

// Sequential (maxWorkers=1) by design: swe-marathon tasks demand large CPU/RAM,
// so overlapping container builds would thrash the shared host.
export async function runSweMarathonRun(
  input: RunSweMarathonRunInput,
): Promise<{ layout: SweMarathonRunLayout; summary: SweMarathonRunSummary; results: readonly SweMarathonTrialResult[] }> {
  const layout = sweMarathonRunLayout(input.rootDir, input.runId)
  await mkdir(layout.rootDir, { recursive: true })
  await mkdir(layout.trialsDir, { recursive: true })

  const tasks = await resolveSweMarathonTasks({
    tasksDir: input.tasksDir,
    ...(input.taskIds ? { taskIds: input.taskIds } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  })
  await writeFile(
    layout.tasksJsonl,
    tasks.map((t) => JSON.stringify({ taskId: t.taskId, difficulty: t.difficulty, category: t.category })).join('\n') + (tasks.length ? '\n' : ''),
    'utf8',
  )

  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()
  const progress: SweMarathonRunProgress = {
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

  const results: SweMarathonTrialResult[] = []
  for (const task of tasks) {
    progress.currentTask = task.taskId
    progress.lastUpdatedAt = new Date().toISOString()
    progress.updatedAt = progress.lastUpdatedAt
    await writeProgress(layout.progressPath, progress)
    const logsDir = join(layout.trialsDir, `${task.taskId}-logs`)
    await mkdir(join(logsDir, 'verifier'), { recursive: true })
    const result = await runSweMarathonTrial({
      task,
      runId: input.runId,
      logsDir,
      ...(input.agentWorkspaceByTask?.[task.taskId] ? { agentWorkspace: input.agentWorkspaceByTask[task.taskId] } : {}),
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

  await writeFile(layout.resultsJsonl, results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''), 'utf8')

  const summary: SweMarathonRunSummary = {
    runId: input.runId,
    total: results.length,
    resolved: progress.resolved,
    unresolved: progress.unresolved,
    errored: progress.errored,
    accuracy: results.length === 0 ? 0 : progress.resolved / results.length,
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
    kind: 'swe-marathon',
    dataset: input.dataset ?? 'swe-marathon/local',
    model: input.model ?? 'unspecified',
    runDir: layout.rootDir,
    selectedCount: tasks.length,
    maxWorkers: 1,
    shardCount: 1,
  })

  return { layout, summary, results }
}

async function writeProgress(path: string, progress: SweMarathonRunProgress): Promise<void> {
  await writeFile(path, `${JSON.stringify(progress, null, 2)}\n`, 'utf8')
}

export type ImportSweMarathonResultsInput = {
  rootDir: string
  runId: string
}

export async function importSweMarathonResults(
  input: ImportSweMarathonResultsInput,
): Promise<SweMarathonRunSummary> {
  const layout = sweMarathonRunLayout(input.rootDir, input.runId)
  if (!existsSync(layout.resultsJsonl)) {
    throw new Error(`SWE-Marathon results not found for run ${input.runId}`)
  }
  const raw = await readFile(layout.resultsJsonl, 'utf8')
  let total = 0
  let resolved = 0
  let unresolved = 0
  let errored = 0
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const row = JSON.parse(line) as SweMarathonTrialResult
    total += 1
    if (row.status === 'resolved') resolved += 1
    else if (row.status === 'unresolved') unresolved += 1
    else errored += 1
  }
  const summary: SweMarathonRunSummary = {
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

// --- helpers -------------------------------------------------------------

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 48)
}

function tail(value: string): string {
  return value.length <= TAIL ? value : value.slice(-TAIL)
}

// Minimal, dependency-free TOML section/key readers (mirrors the audit script
// approach in scripts/eval/benchmarks/swe-marathon). Handles top-level string
// and number keys within a named `[section]`.
function tomlSection(toml: string, section: string): string {
  const re = new RegExp(`(^|\\n)\\[${escapeRe(section)}\\]([\\s\\S]*?)(?=\\n\\[|$)`)
  const m = re.exec(toml)
  return m ? m[2] ?? '' : ''
}

function tomlString(toml: string, section: string, key: string): string | undefined {
  const body = tomlSection(toml, section)
  const m = new RegExp(`\\n\\s*${escapeRe(key)}\\s*=\\s*"([^"]*)"`).exec(`\n${body}`)
  return m ? m[1] : undefined
}

function tomlNumber(toml: string, section: string, key: string): number | undefined {
  const body = tomlSection(toml, section)
  const m = new RegExp(`\\n\\s*${escapeRe(key)}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)`).exec(`\n${body}`)
  return m ? Number(m[1]) : undefined
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function removeImage(imageTag: string): Promise<void> {
  // Only ever removes the exact prefixed image we built. Never prunes.
  if (!imageTag.startsWith('ak-eval-swemara-')) return
  try {
    await runProcess('docker', ['image', 'rm', '-f', imageTag], { timeoutMs: 60_000 })
  } catch {
    // best-effort cleanup
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
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
