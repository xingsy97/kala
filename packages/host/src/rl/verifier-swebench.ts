import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentRewardArtifactSchema,
  createArtifactStore,
  type AgentRewardArtifact,
  type AgentRlTask,
  type ArtifactRef,
} from '@agent-kernel/shared/enhancement'

export type SwebenchVerifierInput = {
  rootDir: string
  rolloutId: string
  task: AgentRlTask
  cwd: string
}

export type SwebenchVerifierResult = {
  artifact: ArtifactRef
  reward: AgentRewardArtifact
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string },
) => Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }>

export type ReportReader = (path: string) => Promise<{ resolved: boolean; f2p?: readonly string[]; p2p?: readonly string[] } | null>

export type SwebenchVerifierOptions = {
  runner?: CommandRunner
  reportReader?: ReportReader
  workDir?: string
  datasetName?: string
  modelName?: string
}

const defaultRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(command, args as string[], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeoutMs = opts.timeoutMs ?? 600_000
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 1000).unref()
    }, timeoutMs)
    timer.unref()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c) => { stdout += String(c) })
    child.stderr?.on('data', (c) => { stderr += String(c) })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: null, signal: null, stdout, stderr: stderr + err.message, timedOut: false })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ exitCode: code, signal, stdout, stderr, timedOut })
    })
    if (opts.stdin !== undefined && child.stdin) child.stdin.end(opts.stdin)
  })

const defaultReportReader: ReportReader = async (path) => {
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw)
  const first = parsed && typeof parsed === 'object'
    ? Object.values(parsed as Record<string, unknown>)[0] ?? parsed
    : parsed
  const rec = first as Record<string, unknown> | null
  if (!rec || typeof rec !== 'object') return null
  const resolved = Boolean(rec.resolved)
  const tests = (rec.tests_status ?? rec.tests) as Record<string, unknown> | undefined
  const f2p = extractPassing(tests, 'FAIL_TO_PASS')
  const p2p = extractPassing(tests, 'PASS_TO_PASS')
  return { resolved, f2p, p2p }
}

function extractPassing(tests: Record<string, unknown> | undefined, key: string): readonly string[] | undefined {
  if (!tests) return undefined
  const section = tests[key] as Record<string, unknown> | readonly string[] | undefined
  if (!section) return undefined
  if (Array.isArray(section)) return section as readonly string[]
  const success = (section as Record<string, unknown>).success
  if (Array.isArray(success)) return success as readonly string[]
  return undefined
}

function sanitize(v: string): string {
  const c = v.replace(/[^A-Za-z0-9._:-]+/g, '_')
  return c.length > 0 ? c : 'unknown'
}

function getInstanceId(task: AgentRlTask): string {
  const v = task.verifier as unknown as { instanceId?: string }
  if (typeof v.instanceId === 'string' && v.instanceId.length > 0) return v.instanceId
  const meta = task.metadata as Record<string, unknown> | undefined
  const id = meta?.instanceId
  if (typeof id === 'string' && id.length > 0) return id
  throw new Error(`swebench verifier: task ${task.taskId} missing verifier.instanceId`)
}

export async function runSwebenchVerifier(
  input: SwebenchVerifierInput,
  options: SwebenchVerifierOptions = {},
): Promise<SwebenchVerifierResult> {
  if (input.task.verifier.kind !== 'swebench') {
    throw new Error(`runSwebenchVerifier called with verifier kind=${input.task.verifier.kind}`)
  }
  await mkdir(input.rootDir, { recursive: true })
  const runner = options.runner ?? defaultRunner
  const reportReader = options.reportReader ?? defaultReportReader
  const workDir = options.workDir ?? tmpdir()
  const datasetName = options.datasetName ?? 'princeton-nlp/SWE-bench_Verified'
  const modelName = options.modelName ?? 'agent-kernel'
  const runId = sanitize(input.rolloutId)
  const instanceId = getInstanceId(input.task)
  const timeoutMs = input.task.verifier.timeoutMs

  const startedAt = new Date()

  // 1. Extract agent's patch from cwd
  // Stage all changes (including untracked new files) so `git diff --cached` sees them.
  await runner('git', ['add', '-A'], { cwd: input.cwd, timeoutMs: 60_000 })
  const diff = await runner('git', ['diff', '--binary', '--cached', 'HEAD'], { cwd: input.cwd, timeoutMs: 60_000 })
  const patch = diff.exitCode === 0 ? diff.stdout : ''
  const emptyPatch = patch.trim().length === 0

  const store = createArtifactStore(input.rootDir)
  const patchArtifact = await store.writeText('log', `rl-verifier/${runId}/patch.diff`, patch)

  if (emptyPatch) {
    return finalize({
      input,
      startedAt,
      runId,
      instanceId,
      reward: 0,
      label: 'unresolved',
      exitCode: null,
      timedOut: false,
      metadata: { reason: 'empty_patch' },
      patchArtifact,
      store,
    })
  }

  // 2. Write predictions JSON
  const predPath = join(workDir, `pred-${runId}.json`)
  const pred = [createSwebenchPrediction({ instanceId, modelNameOrPath: modelName, modelPatch: patch })]
  await writeFile(predPath, JSON.stringify(pred), 'utf8')

  // 3. Invoke harness
  const harnessArgs = [
    '-m', 'swebench.harness.run_evaluation',
    '--dataset_name', datasetName,
    '--predictions_path', predPath,
    '--instance_ids', instanceId,
    '--run_id', runId,
    '--max_workers', '1',
  ]
  const run = await runner('python3', harnessArgs, { timeoutMs })
  const stdoutArtifact = await store.writeText('log', `rl-verifier/${runId}/harness-stdout.txt`, run.stdout)
  const stderrArtifact = await store.writeText('log', `rl-verifier/${runId}/harness-stderr.txt`, run.stderr)

  if (run.timedOut) {
    return finalize({
      input,
      startedAt,
      runId,
      instanceId,
      reward: 0,
      label: 'timeout',
      exitCode: run.exitCode,
      timedOut: true,
      metadata: { reason: 'timeout', stdoutRef: stdoutArtifact, stderrRef: stderrArtifact },
      patchArtifact,
      store,
    })
  }

  // 4. Read harness report
  const reportPath = join(process.cwd(), 'logs', 'run_evaluation', runId, modelName, instanceId, 'report.json')
  const altPath = join('evaluation_results', runId, instanceId, 'report.json')
  const report =
    (await reportReader(reportPath).catch(() => null)) ??
    (await reportReader(altPath).catch(() => null))

  const resolved = report?.resolved === true
  return finalize({
    input,
    startedAt,
    runId,
    instanceId,
    reward: resolved ? 1 : 0,
    label: resolved ? 'resolved' : 'unresolved',
    exitCode: run.exitCode,
    timedOut: false,
    metadata: {
      f2pPassed: report?.f2p ?? [],
      p2pPassed: report?.p2p ?? [],
      reportFound: report !== null,
      stdoutRef: stdoutArtifact,
      stderrRef: stderrArtifact,
    },
    patchArtifact,
    store,
  })
}

function createSwebenchPrediction(input: {
  instanceId: string
  modelNameOrPath: string
  modelPatch: string
}): { instance_id: string; model_name_or_path: string; model_patch: string } {
  return {
    instance_id: input.instanceId,
    model_name_or_path: input.modelNameOrPath,
    model_patch: input.modelPatch,
  }
}

async function finalize(args: {
  input: SwebenchVerifierInput
  startedAt: Date
  runId: string
  instanceId: string
  reward: number
  label: AgentRewardArtifact['label']
  exitCode: number | null
  timedOut: boolean
  metadata: Record<string, unknown>
  patchArtifact: ArtifactRef
  store: ReturnType<typeof createArtifactStore>
}): Promise<SwebenchVerifierResult> {
  const completedAt = new Date()
  const reward: AgentRewardArtifact = {
    schemaVersion: 'agent.reward.v1',
    rolloutId: args.input.rolloutId,
    taskId: args.input.task.taskId,
    verifierKind: 'swebench',
    reward: args.reward,
    label: args.label,
    startedAt: args.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - args.startedAt.getTime(),
    exitCode: args.exitCode,
    patchRef: args.patchArtifact,
    metadata: { instanceId: args.instanceId, ...args.metadata },
  }
  AgentRewardArtifactSchema.parse(reward)
  const artifact = await args.store.writeJson(
    'rl_reward',
    `rl-rewards/${args.runId}.json`,
    reward,
  )
  return { artifact, reward }
}
