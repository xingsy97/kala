import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  buildSweBenchEvaluationCommand,
  createArtifactStore,
  createEvalExperiment,
  createSweBenchPrediction,
  exportSessionSpans,
  serializeJsonl,
  type ArtifactRef,
  type EvalExperiment,
  type SweBenchPrediction,
} from '@agent-kernel/shared'

import { readSessionLog } from '../store/log.js'

export type SweBenchRunLayout = {
  runId: string
  rootDir: string
  predictionsPath: string
  experimentPath: string
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

