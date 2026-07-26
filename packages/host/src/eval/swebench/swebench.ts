import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import {
  buildSweBenchEvaluationCommand,
  createArtifactStore,
  createEvalExperiment,
  createSweBenchPrediction,
  deriveEvalMemoryPolicy,
  exportSessionSpans,
  redactForPersistence,
  serializeJsonl,
  summarizeEvalRun,
  type ArtifactRef,
  type EvalFailureLabel,
  type EvalExperiment,
  type EvalMemoryPolicy,
  type EvalTrial,
  type SweBenchPrediction,
} from '@agent-kernel/shared/enhancement'

import { readSessionLog } from '../../store/log.js'
import { registerSweBenchRun } from '../core/run-registry.js'

async function loadTrialSubAgentGraph(sessionsDir: string): Promise<{
  nodes: Array<{ sessionId: string; parentSessionId?: string }>
  edges: Array<{ parentSessionId: string; childSessionId: string }>
} | undefined> {
  if (!existsSync(sessionsDir)) return undefined
  const files = (await readdir(sessionsDir)).filter((file) => file.endsWith('.jsonl'))
  if (files.length === 0) return undefined
  const nodes: Array<{ sessionId: string; parentSessionId?: string }> = []
  const edges: Array<{ parentSessionId: string; childSessionId: string }> = []
  for (const file of files) {
    try {
      const parsed = await readSessionLog(join(sessionsDir, file))
      nodes.push({
        sessionId: parsed.header.sessionId,
        ...(parsed.header.parentSessionId ? { parentSessionId: parsed.header.parentSessionId } : {}),
      })
      if (parsed.header.parentSessionId) {
        edges.push({
          parentSessionId: parsed.header.parentSessionId,
          childSessionId: parsed.header.sessionId,
        })
      }
    } catch {
      // ignore malformed sessions when scanning for subagent edges
    }
  }
  return { nodes, edges }
}

export type SweBenchRunLayout = {
  runId: string
  rootDir: string
  predictionsPath: string
  experimentPath: string
  progressPath: string
  instancesPath: string
  summaryPath: string
  trialsDir: string
  tracesDir: string
  artifactsDir: string
  patchesDir: string
  gradeResultsDir: string
  inputsDir: string
}

export function sweBenchRunLayout(rootDir: string, runId: string): SweBenchRunLayout {
  const runRoot = join(rootDir, runId)
  return {
    runId,
    rootDir: runRoot,
    predictionsPath: join(runRoot, 'predictions.jsonl'),
    experimentPath: join(runRoot, 'experiment.json'),
    progressPath: join(runRoot, 'progress.json'),
    instancesPath: join(runRoot, 'instances.jsonl'),
    summaryPath: join(runRoot, 'summary.json'),
    trialsDir: join(runRoot, 'trials'),
    tracesDir: join(runRoot, 'traces'),
    artifactsDir: join(runRoot, 'artifacts'),
    patchesDir: join(runRoot, 'patches'),
    gradeResultsDir: join(runRoot, 'grade-results'),
    inputsDir: join(runRoot, 'inputs'),
  }
}

export type WriteSweBenchPredictionInput = {
  rootDir: string
  runId: string
  dataset: string
  split?: string
  model: string
  predictions: readonly SweBenchPrediction[]
  config?: Record<string, unknown>
  memoryPolicy?: EvalMemoryPolicy
}

export async function writeSweBenchPredictionRun(
  input: WriteSweBenchPredictionInput,
): Promise<{ layout: SweBenchRunLayout; experiment: EvalExperiment }> {
  const layout = sweBenchRunLayout(input.rootDir, input.runId)
  await mkdir(layout.rootDir, { recursive: true })
  const memoryPolicy = input.memoryPolicy ?? deriveEvalMemoryPolicy({ benchmarkIsolation: true })
  const experiment = createEvalExperiment({
    experimentId: input.runId,
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    config: input.config,
    memoryPolicy,
  })
  await writeFile(layout.experimentPath, `${JSON.stringify(experiment, null, 2)}\n`, 'utf8')
  await writeFile(layout.predictionsPath, serializeJsonl(input.predictions), 'utf8')
  return { layout, experiment }
}

export type SweBenchInstance = {
  instance_id: string
  repo?: string
  base_commit?: string
  problem_statement?: string
  version?: string
  [key: string]: unknown
}

export type SweBenchInstanceProgress = {
  instanceId: string
  status: 'queued' | 'running' | 'skipped' | 'completed' | 'failed' | 'timed_out'
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  failureLabel?: EvalFailureLabel
  artifactRefs?: readonly ArtifactRef[]
  metrics?: Record<string, number | string | boolean>
}

export type SweBenchRunProgress = {
  schemaVersion: 1
  runId: string
  dataset: string
  split?: string
  model: string
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  updatedAt: string
  finishedAt?: string
  selectedCount: number
  queuedCount: number
  runningCount: number
  skippedCount: number
  completedCount: number
  failedCount: number
  timedOutCount: number
  maxWorkers: number
  instances: readonly SweBenchInstanceProgress[]
}

export type InferSweBenchPatchRunInput = {
  rootDir: string
  runId: string
  dataset: string
  split?: string
  model: string
  instancesJsonl: string
  patchesDir: string
  instanceIds?: readonly string[]
  limit?: number
  workspaceRoot?: string
  memoryPolicy?: EvalMemoryPolicy
}

export async function inferSweBenchPatchRun(
  input: InferSweBenchPatchRunInput,
): Promise<{
  layout: SweBenchRunLayout
  experiment: EvalExperiment
  predictions: readonly SweBenchPrediction[]
  trials: readonly EvalTrial[]
}> {
  const allInstances = await readSweBenchInstances(input.instancesJsonl)
  const selected = selectInstances(allInstances, input.instanceIds, input.limit)
  const predictions: SweBenchPrediction[] = []
  const trials: EvalTrial[] = []
  const { layout, experiment } = await writeSweBenchPredictionRun({
    rootDir: input.rootDir,
    runId: input.runId,
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    predictions: [],
    config: {
      mode: 'offline-patch-infer',
      instancesJsonl: basename(input.instancesJsonl),
      patchesDir: basename(input.patchesDir),
      instanceIds: input.instanceIds ?? [],
      limit: input.limit ?? null,
    },
    memoryPolicy: input.memoryPolicy ?? deriveEvalMemoryPolicy({ benchmarkIsolation: true }),
  })
  await mkdir(layout.trialsDir, { recursive: true })
  await writeFile(layout.instancesPath, serializeJsonl(selected), 'utf8')
  const store = createArtifactStore(layout.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })

  for (const instance of selected) {
    const patch = await readPatchForInstance(input.patchesDir, instance.instance_id)
    const diffArtifact = await store.writeText(
      'diff',
      `artifacts/${instance.instance_id}/final.diff`,
      patch,
    )
    const prediction = createSweBenchPrediction({
      instanceId: instance.instance_id,
      modelNameOrPath: input.model,
      modelPatch: patch,
    })
    predictions.push(prediction)
    const emptyPatch = patch.trim().length === 0
    const trial: EvalTrial = {
      trialId: `${input.runId}:${instance.instance_id}`,
      experimentId: experiment.experimentId,
      instanceId: instance.instance_id,
      status: 'completed',
      resolved: false,
      ...(emptyPatch ? { failureLabel: 'empty_patch' } : {}),
      artifacts: [diffArtifact],
      metrics: {
        patchBytes: Buffer.byteLength(patch, 'utf8'),
        patchLines: patch.length === 0 ? 0 : patch.split('\n').length,
      },
    }
    trials.push(trial)
    await writeFile(
      join(layout.trialsDir, `${instance.instance_id}.json`),
      `${JSON.stringify(trial, null, 2)}\n`,
      'utf8',
    )
  }

  await writeFile(layout.predictionsPath, serializeJsonl(predictions), 'utf8')
  await writeFile(
    layout.summaryPath,
    `${JSON.stringify(summarizeEvalRun(experiment, trials), null, 2)}\n`,
    'utf8',
  )
  return { layout, experiment, predictions, trials }
}

export type RunSweBenchAgentPatchInput = {
  rootDir: string
  runId: string
  dataset: string
  split?: string
  model: string
  instancesJsonl: string
  agentCommand: string
  instanceIds?: readonly string[]
  limit?: number
  workspaceRoot?: string
  repoCacheDir?: string
  timeoutMs?: number
  maxWorkers?: number
  skipCompleted?: boolean
  memoryPolicy?: EvalMemoryPolicy
  sessionLogsDir?: string
  signal?: AbortSignal
}

export type SweBenchWorkerPlanInput = {
  rootDir: string
  runId: string
  dataset: string
  split?: string
  model: string
  instancesJsonl: string
  instanceIds?: readonly string[]
  limit?: number
  maxWorkers?: number
  timeoutMs?: number
  repoCacheDir?: string
}

export type SweBenchWorkerPlan = {
  schemaVersion: 1
  generatedAt: string
  runId: string
  dataset: string
  split?: string
  model: string
  selectedCount: number
  maxWorkers: number
  shards: Array<{
    workerId: number
    instanceCount: number
    instanceIds: readonly string[]
  }>
  resourceHints: {
    dockerRequired: true
    workspaceIsolation: 'per-instance-git-clone'
    maxConcurrentWorkspaces: number
    repoCacheDir?: string
    timeoutMs?: number
  }
  warnings: readonly string[]
}

export async function planSweBenchWorkerRun(
  input: SweBenchWorkerPlanInput,
): Promise<{ layout: SweBenchRunLayout; plan: SweBenchWorkerPlan; planPath: string; registryPath: string }> {
  const allInstances = await readSweBenchInstances(input.instancesJsonl)
  const selected = selectInstances(allInstances, input.instanceIds, input.limit)
  const layout = sweBenchRunLayout(input.rootDir, input.runId)
  await mkdir(layout.rootDir, { recursive: true })
  const maxWorkers = Math.max(1, Math.floor(input.maxWorkers ?? 1))
  const shards = Array.from({ length: Math.min(maxWorkers, Math.max(1, selected.length)) }, (_, index) => ({
    workerId: index + 1,
    instanceIds: [] as string[],
  }))
  selected.forEach((instance, index) => {
    shards[index % shards.length]!.instanceIds.push(instance.instance_id)
  })
  const warnings: string[] = []
  if (selected.length === 0) warnings.push('no instances selected')
  if ((input.maxWorkers ?? 1) > selected.length && selected.length > 0) warnings.push('maxWorkers exceeds selected instance count')
  const plan: SweBenchWorkerPlan = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: input.runId,
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    selectedCount: selected.length,
    maxWorkers,
    shards: shards.map((shard) => ({
      workerId: shard.workerId,
      instanceCount: shard.instanceIds.length,
      instanceIds: shard.instanceIds,
    })),
    resourceHints: {
      dockerRequired: true,
      workspaceIsolation: 'per-instance-git-clone',
      maxConcurrentWorkspaces: Math.min(maxWorkers, Math.max(1, selected.length)),
      ...(input.repoCacheDir ? { repoCacheDir: input.repoCacheDir } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    },
    warnings,
  }
  const planPath = join(layout.rootDir, 'worker-plan.json')
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  const registered = await registerSweBenchRun({
    rootDir: input.rootDir,
    runId: input.runId,
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    planPath,
    runDir: layout.rootDir,
    selectedCount: plan.selectedCount,
    maxWorkers: plan.maxWorkers,
    shardCount: plan.shards.length,
  })
  return { layout, plan, planPath, registryPath: registered.path }
}

export async function runSweBenchAgentPatchRun(
  input: RunSweBenchAgentPatchInput,
): Promise<{
  layout: SweBenchRunLayout
  experiment: EvalExperiment
  predictions: readonly SweBenchPrediction[]
  trials: readonly EvalTrial[]
}> {
  const allInstances = await readSweBenchInstances(input.instancesJsonl)
  const selected = selectInstances(allInstances, input.instanceIds, input.limit)
  const priorRun = input.skipCompleted
    ? await readExistingSweBenchRunOutputs(sweBenchRunLayout(input.rootDir, input.runId))
    : { predictions: [], trials: [] }
  const redactedCommand = redactForPersistence(input.agentCommand, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const { layout, experiment } = await writeSweBenchPredictionRun({
    rootDir: input.rootDir,
    runId: input.runId,
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    predictions: [],
    config: {
      mode: 'agent-command-infer',
      instancesJsonl: basename(input.instancesJsonl),
      instanceIds: input.instanceIds ?? [],
      limit: input.limit ?? null,
      timeoutMs: input.timeoutMs ?? null,
      maxWorkers: input.maxWorkers ?? 1,
      skipCompleted: input.skipCompleted ?? false,
      agentCommandSha256: createHash('sha256').update(input.agentCommand).digest('hex'),
      agentCommandPreview: redactedCommand.value,
      agentCommandRedaction: redactedCommand.summary,
    },
    memoryPolicy: input.memoryPolicy ?? deriveEvalMemoryPolicy({ benchmarkIsolation: true }),
  })
  await mkdir(layout.trialsDir, { recursive: true })
  await writeFile(layout.instancesPath, serializeJsonl(selected), 'utf8')
  const store = createArtifactStore(layout.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const predictions: SweBenchPrediction[] = []
  const trials: EvalTrial[] = []
  if (input.skipCompleted) {
    predictions.push(...priorRun.predictions.filter((prediction) => selected.some((instance) => instance.instance_id === prediction.instance_id)))
    trials.push(...priorRun.trials.filter((trial) => selected.some((instance) => instance.instance_id === trial.instanceId)))
  }
  const completedIds = new Set(trials.map((trial) => trial.instanceId))
  const pending = selected.filter((instance) => !completedIds.has(instance.instance_id))
  const startedAt = new Date().toISOString()
  const progressByInstance = new Map<string, SweBenchInstanceProgress>()
  for (const instance of selected) {
    const existing = trials.find((trial) => trial.instanceId === instance.instance_id)
    progressByInstance.set(instance.instance_id, existing
      ? progressFromTrial(existing, 'skipped')
      : { instanceId: instance.instance_id, status: 'queued' })
  }
  await writeSweBenchProgress(layout, buildSweBenchProgress({
    input,
    selected,
    progressByInstance,
    startedAt,
    status: 'running',
  }))

  const results = await runWithConcurrency(
    pending,
    input.maxWorkers ?? 1,
    async (instance) => {
      progressByInstance.set(instance.instance_id, {
        instanceId: instance.instance_id,
        status: 'running',
        startedAt: new Date().toISOString(),
      })
      await writeSweBenchProgress(layout, buildSweBenchProgress({
        input,
        selected,
        progressByInstance,
        startedAt,
        status: 'running',
      }))
      const result = await runSingleSweBenchAgentInstance({ input, layout, experiment, store, instance })
      progressByInstance.set(instance.instance_id, progressFromTrial(result.trial))
      await writeSweBenchProgress(layout, buildSweBenchProgress({
        input,
        selected,
        progressByInstance,
        startedAt,
        status: 'running',
      }))
      return result
    },
  )
  for (const result of results) {
    predictions.push(result.prediction)
    trials.push(result.trial)
    await writeFile(
      join(layout.trialsDir, `${result.trial.instanceId}.json`),
      `${JSON.stringify(result.trial, null, 2)}\n`,
      'utf8',
    )
  }

  const orderedPredictions = orderBySelectedInstances(predictions, selected, (prediction) => prediction.instance_id)
  const orderedTrials = orderBySelectedInstances(trials, selected, (trial) => trial.instanceId)
  await writeFile(layout.predictionsPath, serializeJsonl(orderedPredictions), 'utf8')
  await writeFile(layout.summaryPath, `${JSON.stringify(summarizeEvalRun(experiment, orderedTrials), null, 2)}\n`, 'utf8')
  await writeSweBenchProgress(layout, buildSweBenchProgress({
    input,
    selected,
    progressByInstance,
    startedAt,
    status: orderedTrials.some((trial) => trial.status === 'failed' || trial.status === 'timed_out') ? 'failed' : 'completed',
    finishedAt: new Date().toISOString(),
  }))
  return { layout, experiment, predictions: orderedPredictions, trials: orderedTrials }
}

function progressFromTrial(trial: EvalTrial, overrideStatus?: SweBenchInstanceProgress['status']): SweBenchInstanceProgress {
  const status = overrideStatus ?? (trial.status === 'pending' ? 'queued' : trial.status)
  return {
    instanceId: trial.instanceId,
    status,
    ...(trial.failureLabel ? { failureLabel: trial.failureLabel } : {}),
    artifactRefs: trial.artifacts,
    metrics: trial.metrics,
    ...(typeof trial.metrics.durationMs === 'number' ? { durationMs: trial.metrics.durationMs } : {}),
  }
}

function buildSweBenchProgress(input: {
  input: RunSweBenchAgentPatchInput
  selected: readonly SweBenchInstance[]
  progressByInstance: ReadonlyMap<string, SweBenchInstanceProgress>
  startedAt: string
  status: SweBenchRunProgress['status']
  finishedAt?: string
}): SweBenchRunProgress {
  const instances = input.selected.map((instance) => input.progressByInstance.get(instance.instance_id) ?? {
    instanceId: instance.instance_id,
    status: 'queued' as const,
  })
  const count = (status: SweBenchInstanceProgress['status']): number => instances.filter((instance) => instance.status === status).length
  return {
    schemaVersion: 1,
    runId: input.input.runId,
    dataset: input.input.dataset,
    ...(input.input.split ? { split: input.input.split } : {}),
    model: input.input.model,
    status: input.status,
    startedAt: input.startedAt,
    updatedAt: input.finishedAt ?? new Date().toISOString(),
    ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
    selectedCount: instances.length,
    queuedCount: count('queued'),
    runningCount: count('running'),
    skippedCount: count('skipped'),
    completedCount: count('completed'),
    failedCount: count('failed'),
    timedOutCount: count('timed_out'),
    maxWorkers: input.input.maxWorkers ?? 1,
    instances,
  }
}

async function writeSweBenchProgress(layout: SweBenchRunLayout, progress: SweBenchRunProgress): Promise<void> {
  const redacted = redactForPersistence(progress, { workspaceRoot: dirname(layout.rootDir) })
  await writeFile(layout.progressPath, `${JSON.stringify(redacted.value, null, 2)}\n`, 'utf8')
}

async function readSweBenchInstances(path: string): Promise<SweBenchInstance[]> {
  const raw = await readFile(path, 'utf8')
  const out: SweBenchInstance[] = []
  for (const [i, line] of raw.split('\n').entries()) {
    if (line.trim().length === 0) continue
    const parsed = JSON.parse(line) as Partial<SweBenchInstance>
    if (!parsed.instance_id) throw new Error(`SWE-bench instance line ${i + 1} missing instance_id`)
    out.push(parsed as SweBenchInstance)
  }
  return out
}

function selectInstances(
  instances: readonly SweBenchInstance[],
  ids: readonly string[] | undefined,
  limit: number | undefined,
): SweBenchInstance[] {
  const wanted = ids && ids.length > 0 ? new Set(ids) : undefined
  const filtered = wanted ? instances.filter((instance) => wanted.has(instance.instance_id)) : [...instances]
  return typeof limit === 'number' ? filtered.slice(0, limit) : filtered
}

async function readExistingSweBenchRunOutputs(layout: SweBenchRunLayout): Promise<{
  predictions: SweBenchPrediction[]
  trials: EvalTrial[]
}> {
  const predictions: SweBenchPrediction[] = []
  if (existsSync(layout.predictionsPath)) {
    const raw = await readFile(layout.predictionsPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      predictions.push(JSON.parse(line) as SweBenchPrediction)
    }
  }
  const trials: EvalTrial[] = []
  for (const prediction of predictions) {
    const trial = await readExistingTrial(layout, prediction.instance_id)
    if (trial) trials.push(trial)
  }
  return { predictions, trials }
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  maxWorkers: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(maxWorkers))
  const results = new Array<R>(items.length)
  let index = 0
  async function runWorker(): Promise<void> {
    while (true) {
      const current = index
      index += 1
      const item = items[current]
      if (item === undefined) return
      results[current] = await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => runWorker()))
  return results
}

function orderBySelectedInstances<T>(items: readonly T[], selected: readonly SweBenchInstance[], idOf: (item: T) => string): T[] {
  const order = new Map(selected.map((instance, index) => [instance.instance_id, index]))
  return [...items].sort((a, b) => (order.get(idOf(a)) ?? Number.MAX_SAFE_INTEGER) - (order.get(idOf(b)) ?? Number.MAX_SAFE_INTEGER))
}

async function readPatchForInstance(patchesDir: string, instanceId: string): Promise<string> {
  const candidates = [
    join(patchesDir, `${instanceId}.diff`),
    join(patchesDir, `${instanceId}.patch`),
  ]
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return ''
}

type AgentInstanceRunInput = {
  input: RunSweBenchAgentPatchInput
  layout: SweBenchRunLayout
  experiment: EvalExperiment
  store: ReturnType<typeof createArtifactStore>
  instance: SweBenchInstance
}

async function runSingleSweBenchAgentInstance({
  input,
  layout,
  experiment,
  store,
  instance,
}: AgentInstanceRunInput): Promise<{ prediction: SweBenchPrediction; trial: EvalTrial }> {
  const startedAt = Date.now()
  const workspaceDir = resolve(join(layout.rootDir, 'workspaces', instance.instance_id))
  const artifacts: ArtifactRef[] = []
  let exitCode: number | null = null
  let timedOut = false
  let setupError: string | undefined

  try {
    await materializeSweBenchWorkspace(instance, workspaceDir, input.repoCacheDir)
  } catch (err) {
    setupError = err instanceof Error ? err.message : String(err)
  }

  const prompt = createSweBenchAgentPrompt(instance, workspaceDir)
  artifacts.push(await store.writeText('metadata', `artifacts/${instance.instance_id}/prompt.txt`, prompt))

  const sessionLogsDir = resolve(input.sessionLogsDir ?? join(layout.rootDir, 'sessions'))
  const sessionLogPath = join(sessionLogsDir, `${instance.instance_id}.jsonl`)
  const promptFilePath = resolve(join(layout.rootDir, 'artifacts', instance.instance_id, 'prompt.txt'))
  await mkdir(sessionLogsDir, { recursive: true })

  if (!setupError && !input.signal?.aborted) {
    const command = await runShellCommand(input.agentCommand, {
      cwd: workspaceDir,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      env: {
        AGENT_KERNEL_SWEBENCH_INSTANCE_ID: instance.instance_id,
        AGENT_KERNEL_SWEBENCH_REPO: workspaceDir,
        AGENT_KERNEL_SWEBENCH_PROMPT: prompt,
        AGENT_KERNEL_SWEBENCH_PROMPT_FILE: promptFilePath,
        AGENT_KERNEL_SWEBENCH_SESSION_LOG: sessionLogPath,
      },
    })
    exitCode = command.exitCode
    timedOut = command.timedOut
    artifacts.push(await store.writeText('log', `artifacts/${instance.instance_id}/agent.stdout.log`, command.stdout))
    artifacts.push(await store.writeText('log', `artifacts/${instance.instance_id}/agent.stderr.log`, command.stderr))
  }

  const diff = setupError ? '' : await captureGitDiff(workspaceDir)
  const diffArtifact = await store.writeText('diff', `artifacts/${instance.instance_id}/final.diff`, diff)
  artifacts.push(diffArtifact)
  const metadataArtifact = await store.writeJson('metadata', `artifacts/${instance.instance_id}/workspace-metadata.json`, {
    instanceId: instance.instance_id,
    workspaceDir,
    repo: instance.repo ?? null,
    baseCommit: instance.base_commit ?? null,
    setupError: setupError ?? null,
    exitCode,
    timedOut,
    durationMs: Date.now() - startedAt,
  })
  artifacts.push(metadataArtifact)

  let sessionId: string | undefined
  let eventCount: number | undefined
  if (!setupError && existsSync(sessionLogPath)) {
    try {
      const parsed = await readSessionLog(sessionLogPath)
      sessionId = parsed.header.sessionId
      eventCount = parsed.events.length
      const spans = exportSessionSpans({
        header: parsed.header,
        events: parsed.events,
        runId: input.runId,
        evalInstanceId: instance.instance_id,
      })
      const traceArtifact = await store.writeJson(
        'trace',
        `traces/${instance.instance_id}.openinference.json`,
        { spans },
      )
      artifacts.push(traceArtifact)
    } catch {
      // A malformed or partial session log is not fatal for the eval trial;
      // the diff artifact and stdout/stderr already anchor the failure.
    }
  }

  const prediction = createSweBenchPrediction({
    instanceId: instance.instance_id,
    modelNameOrPath: input.model,
    modelPatch: diff,
  })
  const failureLabel = trialFailureLabel({ setupError, timedOut, exitCode, diff })
  const trial: EvalTrial = {
    trialId: `${input.runId}:${instance.instance_id}`,
    experimentId: experiment.experimentId,
    instanceId: instance.instance_id,
    ...(sessionId ? { sessionId } : {}),
    status: timedOut ? 'timed_out' : failureLabel === undefined ? 'completed' : 'failed',
    resolved: false,
    ...(failureLabel ? { failureLabel } : {}),
    artifacts,
    metrics: {
      durationMs: Date.now() - startedAt,
      patchBytes: Buffer.byteLength(diff, 'utf8'),
      patchLines: diff.length === 0 ? 0 : diff.split('\n').length,
      ...(exitCode === null ? {} : { agentExitCode: exitCode }),
      ...(typeof eventCount === 'number' ? { eventCount } : {}),
    },
  }
  return { prediction, trial }
}

async function materializeSweBenchWorkspace(
  instance: SweBenchInstance,
  workspaceDir: string,
  repoCacheDir: string | undefined,
): Promise<void> {
  await mkdir(dirname(workspaceDir), { recursive: true })
  const source = typeof instance.repo_path === 'string'
    ? instance.repo_path
    : repoCacheDir && instance.repo
      ? join(repoCacheDir, String(instance.repo).replace(/[\\/]/g, '__'))
      : undefined
  if (source) {
    await runRequiredCommand(['git', 'clone', source, workspaceDir], process.cwd())
  } else if (typeof instance.repo === 'string' && instance.repo.includes('/')) {
    await runRequiredCommand(['git', 'clone', `https://github.com/${instance.repo}.git`, workspaceDir], process.cwd())
  } else {
    throw new Error(`instance ${instance.instance_id} has no repo_path, repoCacheDir match, or GitHub repo`)
  }
  if (typeof instance.base_commit === 'string' && instance.base_commit.length > 0) {
    await runRequiredCommand(['git', 'checkout', instance.base_commit], workspaceDir)
  }
}

function createSweBenchAgentPrompt(instance: SweBenchInstance, workspaceDir: string): string {
  const problem = typeof instance.problem_statement === 'string'
    ? instance.problem_statement
    : 'No problem statement was provided.'
  return [
    `SWE-bench instance: ${instance.instance_id}`,
    `Repository: ${instance.repo ?? 'unknown'}`,
    `Workspace: ${workspaceDir}`,
    instance.base_commit ? `Base commit: ${instance.base_commit}` : null,
    '',
    'Task:',
    problem,
    '',
    'Edit the repository to fix the issue. Keep changes minimal. The benchmark output is the git diff left in the workspace, not the final chat answer.',
  ].filter((line): line is string => line !== null).join('\n')
}

function trialFailureLabel(input: {
  setupError: string | undefined
  timedOut: boolean
  exitCode: number | null
  diff: string
}): EvalFailureLabel | undefined {
  if (input.setupError) return 'infrastructure_error'
  if (input.timedOut) return 'agent_timeout'
  if (input.exitCode !== null && input.exitCode !== 0) return 'agent_error'
  if (input.diff.trim().length === 0) return 'empty_patch'
  return undefined
}

async function captureGitDiff(workspaceDir: string): Promise<string> {
  const result = await runShellCommand('git diff --binary', { cwd: workspaceDir })
  return result.stdout
}

async function runRequiredCommand(args: readonly string[], cwd: string): Promise<void> {
  const result = await runProcess(args[0]!, args.slice(1), { cwd })
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed with exit code ${result.exitCode}: ${result.stderr.slice(0, 500)}`)
  }
}

async function runShellCommand(command: string, options: {
  cwd: string
  timeoutMs?: number
  env?: Record<string, string>
  signal?: AbortSignal
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await runProcess(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command], options)
}

async function runProcess(command: string, args: readonly string[], options: {
  cwd: string
  timeoutMs?: number
  env?: Record<string, string>
  signal?: AbortSignal
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const abort = (): void => { child.kill('SIGTERM') }
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
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
      options.signal?.removeEventListener('abort', abort)
      resolve({ exitCode, stdout, stderr, timedOut })
    })
  })
}

export type ExportSessionForSweBenchInput = {
  rootDir: string
  runId: string
  dataset: string
  split?: string
  model: string
  instanceId: string
  sessionLogPath: string
  modelPatch: string
  workspaceRoot?: string
  memoryPolicy?: EvalMemoryPolicy
}

export async function exportSessionForSweBench(
  input: ExportSessionForSweBenchInput,
): Promise<{
  layout: SweBenchRunLayout
  experiment: EvalExperiment
  prediction: SweBenchPrediction
  traceArtifact: ArtifactRef
  trial: EvalTrial
}> {
  const parsed = await readSessionLog(input.sessionLogPath)
  const spans = exportSessionSpans({
    header: parsed.header,
    events: parsed.events,
    runId: input.runId,
    evalInstanceId: input.instanceId,
  })
  const prediction = createSweBenchPrediction({
    instanceId: input.instanceId,
    modelNameOrPath: input.model,
    modelPatch: input.modelPatch,
  })
  const { layout, experiment } = await writeSweBenchPredictionRun({
    rootDir: input.rootDir,
    runId: input.runId,
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    predictions: [prediction],
    config: {
      sessionLogPath: basename(input.sessionLogPath),
      sessionId: parsed.header.sessionId,
      eventCount: parsed.events.length,
    },
    memoryPolicy: input.memoryPolicy ?? deriveEvalMemoryPolicy({ benchmarkIsolation: true }),
  })
  const store = createArtifactStore(layout.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const traceArtifact = await store.writeJson(
    'trace',
    `traces/${input.instanceId}.openinference.json`,
    { spans },
  )
  await mkdir(layout.trialsDir, { recursive: true })
  const diffArtifact = await store.writeText('diff', `artifacts/${input.instanceId}/final.diff`, input.modelPatch)
  const failureLabel = input.modelPatch.trim().length === 0 ? 'empty_patch' : undefined
  const trial: EvalTrial = {
    trialId: `${input.runId}:${input.instanceId}`,
    experimentId: experiment.experimentId,
    instanceId: input.instanceId,
    sessionId: parsed.header.sessionId,
    status: failureLabel ? 'failed' : 'completed',
    resolved: false,
    ...(failureLabel ? { failureLabel } : {}),
    artifacts: [traceArtifact, diffArtifact],
    metrics: {
      eventCount: parsed.events.length,
      patchBytes: Buffer.byteLength(input.modelPatch, 'utf8'),
      patchLines: input.modelPatch.length === 0 ? 0 : input.modelPatch.split('\n').length,
    },
  }
  await writeFile(join(layout.trialsDir, `${input.instanceId}.json`), `${JSON.stringify(trial, null, 2)}\n`, 'utf8')
  const subAgentGraph = await loadTrialSubAgentGraph(dirname(input.sessionLogPath))
  await writeFile(
    layout.summaryPath,
    `${JSON.stringify(summarizeEvalRun(experiment, [trial], subAgentGraph ? { subAgentGraph } : {}), null, 2)}\n`,
    'utf8',
  )
  return { layout, experiment, prediction, traceArtifact, trial }
}

export type SweBenchGradeInput = {
  datasetName: string
  predictionsPath: string
  runId: string
  maxWorkers?: number
  instanceIds?: readonly string[]
  modal?: boolean
  cwd?: string
  execute?: boolean
}

export type SweBenchIngestResultsInput = {
  rootDir: string
  runId: string
  resultsDir: string
}

export type SweBenchIngestedResult = {
  instanceId: string
  resolved: boolean
  failureLabel: 'resolved' | 'patch_apply_failed' | 'test_failed' | 'harness_error'
  raw: unknown
}

export async function ingestSweBenchResults(
  input: SweBenchIngestResultsInput,
): Promise<{
  layout: SweBenchRunLayout
  results: readonly SweBenchIngestedResult[]
  trials: readonly EvalTrial[]
  resultsPath: string
  summaryPath: string
}> {
  const layout = sweBenchRunLayout(input.rootDir, input.runId)
  const experiment = JSON.parse(await readFile(layout.experimentPath, 'utf8')) as EvalExperiment
  const results = await readSweBenchResultRows(input.resultsDir)
  const store = createArtifactStore(layout.rootDir)
  const trialByInstance = new Map<string, EvalTrial>()
  for (const result of results) {
    const existing = await readExistingTrial(layout, result.instanceId)
    const resultArtifact = await store.writeJson('metadata', `artifacts/${result.instanceId}/swebench-result.json`, result.raw)
    const logArtifacts = await collectSweBenchResultLogs(input.resultsDir, result.instanceId, store)
    const trial: EvalTrial = {
      trialId: existing?.trialId ?? `${input.runId}:${result.instanceId}`,
      experimentId: existing?.experimentId ?? experiment.experimentId,
      instanceId: result.instanceId,
      sessionId: existing?.sessionId,
      status: result.resolved ? 'completed' : 'failed',
      resolved: result.resolved,
      failureLabel: result.failureLabel,
      artifacts: mergeArtifactRefs([...(existing?.artifacts ?? []), resultArtifact, ...logArtifacts]),
      metrics: {
        ...(existing?.metrics ?? {}),
        swebenchResolved: result.resolved,
      },
    }
    trialByInstance.set(result.instanceId, trial)
  }
  await mkdir(layout.trialsDir, { recursive: true })
  const trials = [...trialByInstance.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId))
  for (const trial of trials) {
    await writeFile(join(layout.trialsDir, `${trial.instanceId}.json`), `${JSON.stringify(trial, null, 2)}\n`, 'utf8')
  }
  const resultsPath = join(layout.rootDir, 'swebench-results.json')
  await writeFile(resultsPath, `${JSON.stringify({ results }, null, 2)}\n`, 'utf8')
  await writeFile(layout.summaryPath, `${JSON.stringify(summarizeEvalRun(experiment, trials), null, 2)}\n`, 'utf8')
  return { layout, results, trials, resultsPath, summaryPath: layout.summaryPath }
}

async function readExistingTrial(layout: SweBenchRunLayout, instanceId: string): Promise<EvalTrial | undefined> {
  const path = join(layout.trialsDir, `${instanceId}.json`)
  if (!existsSync(path)) return undefined
  return JSON.parse(await readFile(path, 'utf8')) as EvalTrial
}

async function collectSweBenchResultLogs(
  resultsDir: string,
  instanceId: string,
  store: ReturnType<typeof createArtifactStore>,
): Promise<ArtifactRef[]> {
  const files = await collectMatchingFiles(resultsDir, instanceId)
  const out: ArtifactRef[] = []
  for (const file of files) {
    const rel = relative(resultsDir, file).split(sep).join('/')
    const target = `artifacts/${instanceId}/harness/${rel.replace(/[^A-Za-z0-9_./-]/g, '_')}`
    const body = await readFile(file, 'utf8')
    out.push(await store.writeText(inferHarnessArtifactKind(file), target, body))
  }
  return out
}

async function collectMatchingFiles(rootDir: string, instanceId: string): Promise<string[]> {
  const out: string[] = []
  const normalizedInstance = normalizeInstanceForPathMatch(instanceId)

  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(rootDir, path).split(sep).join('/')
      if (!normalizeInstanceForPathMatch(rel).includes(normalizedInstance)) continue
      if (!isTextHarnessArtifact(path)) continue
      const fileStat = await stat(path)
      if (fileStat.size > 2 * 1024 * 1024) continue
      out.push(path)
    }
  }

  await visit(rootDir)
  return out.sort((a, b) => a.localeCompare(b))
}

function normalizeInstanceForPathMatch(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
}

function isTextHarnessArtifact(path: string): boolean {
  return /\.(json|jsonl|log|txt|out|err)$/i.test(path)
}

function inferHarnessArtifactKind(path: string): ArtifactRef['kind'] {
  if (/\.(log|txt|out|err)$/i.test(path)) return 'log'
  return 'metadata'
}

function mergeArtifactRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byKey = new Map<string, ArtifactRef>()
  for (const ref of refs) byKey.set(`${ref.kind}:${ref.uri}`, ref)
  return [...byKey.values()]
}

async function readSweBenchResultRows(resultsDir: string): Promise<SweBenchIngestedResult[]> {
  const instanceJsonl = join(resultsDir, 'instance_results.jsonl')
  const instanceJson = join(resultsDir, 'instance_results.json')
  const resultsJson = join(resultsDir, 'results.json')
  if (existsSync(instanceJsonl)) {
    return parseResultRows((await readFile(instanceJsonl, 'utf8')).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown))
  }
  if (existsSync(instanceJson)) return parseResultRows(JSON.parse(await readFile(instanceJson, 'utf8')) as unknown)
  if (existsSync(resultsJson)) return parseResultRows(JSON.parse(await readFile(resultsJson, 'utf8')) as unknown)
  const aggregateFiles = (await readdir(resultsDir)).filter((name) => name.endsWith('.json')).sort()
  for (const name of aggregateFiles) {
    const raw = JSON.parse(await readFile(join(resultsDir, name), 'utf8')) as unknown
    const rows = parseOfficialAggregateRows(raw)
    if (rows) return rows
  }
  throw new Error(`no SWE-bench result file found in ${resultsDir}`)
}

function parseOfficialAggregateRows(raw: unknown): SweBenchIngestedResult[] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const record = raw as Record<string, unknown>
  const submitted = Array.isArray(record.submitted_ids) ? record.submitted_ids.filter((value): value is string => typeof value === 'string') : []
  if (submitted.length === 0) return
  const resolved = new Set(Array.isArray(record.resolved_ids) ? record.resolved_ids.filter((value): value is string => typeof value === 'string') : [])
  const empty = new Set(Array.isArray(record.empty_patch_ids) ? record.empty_patch_ids.filter((value): value is string => typeof value === 'string') : [])
  const errors = new Set(Array.isArray(record.error_ids) ? record.error_ids.filter((value): value is string => typeof value === 'string') : [])
  return submitted.map((instanceId) => ({
    instanceId,
    resolved: resolved.has(instanceId),
    failureLabel: resolved.has(instanceId) ? 'resolved' : empty.has(instanceId) ? 'patch_apply_failed' : errors.has(instanceId) ? 'harness_error' : 'test_failed',
    raw: { instance_id: instanceId, resolved: resolved.has(instanceId), aggregate: record },
  }))
}

function parseResultRows(raw: unknown): SweBenchIngestedResult[] {
  const rows = normalizeRows(raw)
  return rows.map((row) => {
    const record = row as Record<string, unknown>
    const instanceId = stringField(record, ['instance_id', 'instanceId', 'id'])
    if (!instanceId) throw new Error('SWE-bench result row missing instance_id')
    const resolved = boolField(record, ['resolved', 'success', 'passed']) ?? inferResolved(record)
    return {
      instanceId,
      resolved,
      failureLabel: resolved ? 'resolved' : failureLabelFor(record),
      raw: row,
    }
  })
}

function normalizeRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') throw new Error('SWE-bench results must be an object or array')
  const record = raw as Record<string, unknown>
  for (const key of ['instance_results', 'results', 'instances']) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  for (const key of ['resolved_ids', 'resolved', 'successes', 'passed']) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[]).map((id) => ({ instance_id: id, resolved: true }))
    }
  }
  const maybeRows = Object.entries(record)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([key, value]) => ({ instance_id: key, ...(value as Record<string, unknown>) }))
  if (maybeRows.length > 0) return maybeRows
  throw new Error('SWE-bench results did not contain instance rows')
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function boolField(record: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
  }
  return undefined
}

function inferResolved(record: Record<string, unknown>): boolean {
  const status = stringField(record, ['status', 'result'])?.toLowerCase()
  return status === 'resolved' || status === 'passed' || status === 'success'
}

function failureLabelFor(record: Record<string, unknown>): SweBenchIngestedResult['failureLabel'] {
  const text = JSON.stringify(record).toLowerCase()
  if (text.includes('apply') || text.includes('patch')) return 'patch_apply_failed'
  if (text.includes('harness') || text.includes('docker') || text.includes('timeout')) return 'harness_error'
  return 'test_failed'
}

export function buildSweBenchGradeCommand(input: SweBenchGradeInput): readonly string[] {
  return buildSweBenchEvaluationCommand({
    datasetName: input.datasetName,
    predictionsPath: input.predictionsPath,
    runId: input.runId,
    ...(input.maxWorkers ? { maxWorkers: input.maxWorkers } : {}),
    ...(input.instanceIds ? { instanceIds: input.instanceIds } : {}),
    ...(input.modal ? { modal: input.modal } : {}),
  })
}

export async function runSweBenchGrade(input: SweBenchGradeInput): Promise<{
  command: readonly string[]
  exitCode?: number
}> {
  const command = buildSweBenchGradeCommand(input)
  if (!input.execute) return { command }
  const [bin, ...args] = command
  if (!bin) throw new Error('empty SWE-bench command')
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: 'inherit',
      ...(input.cwd ? { cwd: input.cwd } : {}),
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
  return { command, exitCode }
}
