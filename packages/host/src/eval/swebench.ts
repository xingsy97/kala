import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  buildSweBenchEvaluationCommand,
  createArtifactStore,
  createEvalExperiment,
  createSweBenchPrediction,
  exportSessionSpans,
  serializeJsonl,
  summarizeEvalRun,
  type ArtifactRef,
  type EvalExperiment,
  type EvalTrial,
  type SweBenchPrediction,
} from '@agent-kernel/shared'

import { readSessionLog } from '../store/log.js'

export type SweBenchRunLayout = {
  runId: string
  rootDir: string
  predictionsPath: string
  experimentPath: string
  instancesPath: string
  summaryPath: string
  trialsDir: string
  tracesDir: string
  artifactsDir: string
}

export function sweBenchRunLayout(rootDir: string, runId: string): SweBenchRunLayout {
  const runRoot = join(rootDir, runId)
  return {
    runId,
    rootDir: runRoot,
    predictionsPath: join(runRoot, 'predictions.jsonl'),
    experimentPath: join(runRoot, 'experiment.json'),
    instancesPath: join(runRoot, 'instances.jsonl'),
    summaryPath: join(runRoot, 'summary.json'),
    trialsDir: join(runRoot, 'trials'),
    tracesDir: join(runRoot, 'traces'),
    artifactsDir: join(runRoot, 'artifacts'),
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
}

export async function writeSweBenchPredictionRun(
  input: WriteSweBenchPredictionInput,
): Promise<{ layout: SweBenchRunLayout; experiment: EvalExperiment }> {
  const layout = sweBenchRunLayout(input.rootDir, input.runId)
  await mkdir(layout.rootDir, { recursive: true })
  const experiment = createEvalExperiment({
    experimentId: input.runId,
    dataset: input.dataset,
    ...(input.split ? { split: input.split } : {}),
    model: input.model,
    config: input.config,
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
}

export async function exportSessionForSweBench(
  input: ExportSessionForSweBenchInput,
): Promise<{
  layout: SweBenchRunLayout
  experiment: EvalExperiment
  prediction: SweBenchPrediction
  traceArtifact: ArtifactRef
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
  })
  const store = createArtifactStore(layout.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const traceArtifact = await store.writeJson(
    'trace',
    `traces/${input.instanceId}.openinference.json`,
    { spans },
  )
  return { layout, experiment, prediction, traceArtifact }
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
