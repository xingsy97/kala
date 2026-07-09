import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  createArtifactStore,
  createRolloutSidecar,
  exportSessionSpans,
  type ArtifactRef,
  type RolloutSidecar,
} from '@agent-kernel/shared'

import { readSessionLog } from './store/log.js'

export type ExportSessionTraceInput = {
  rootDir: string
  sessionLogPath: string
  runId?: string
  evalInstanceId?: string
  workspaceRoot?: string
}

export type ExportSessionTraceResult = {
  traceArtifact: ArtifactRef
  llmArtifacts: readonly ArtifactRef[]
  sessionId: string
}

export async function exportSessionTraceArtifacts(
  input: ExportSessionTraceInput,
): Promise<ExportSessionTraceResult> {
  const parsed = await readSessionLog(input.sessionLogPath)
  await mkdir(input.rootDir, { recursive: true })
  const store = createArtifactStore(input.rootDir, {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
  })
  const spans = exportSessionSpans({
    header: parsed.header,
    events: parsed.events,
    runId: input.runId,
    evalInstanceId: input.evalInstanceId,
  })
  const sessionId = parsed.header.sessionId
  const traceArtifact = await store.writeJson(
    'trace',
    `traces/${sessionId}.openinference.json`,
    { spans },
  )
  const llmArtifacts: ArtifactRef[] = []
  for (const entry of parsed.events) {
    if (!entry.llmTrace) continue
    llmArtifacts.push(await store.writeJson(
      'llm_request',
      `llm/${sessionId}/${entry.seq}.request.json`,
      entry.llmTrace.request,
    ))
    if (entry.llmTrace.response) {
      llmArtifacts.push(await store.writeJson(
        'llm_response',
        `llm/${sessionId}/${entry.seq}.response.json`,
        entry.llmTrace.response,
      ))
    }
  }
  return { traceArtifact, llmArtifacts, sessionId }
}

export type ExportRolloutSidecarInput = ExportSessionTraceInput & {
  taskId: string
  frameworkTarget: RolloutSidecar['framework_target']
  model?: string
  weightVersion?: string
  rewardPath?: string
  tokenSegmentsPath?: string
  metadata?: Record<string, unknown>
}

export async function exportRolloutSidecar(
  input: ExportRolloutSidecarInput,
): Promise<{ sidecar: RolloutSidecar; sidecarPath: string; traceArtifact: ArtifactRef }> {
  const trace = await exportSessionTraceArtifacts(input)
  const sidecar = createRolloutSidecar({
    sessionId: trace.sessionId,
    taskId: input.taskId,
    frameworkTarget: input.frameworkTarget,
    eventLogRef: input.sessionLogPath,
    traceRef: trace.traceArtifact.uri,
    ...(input.tokenSegmentsPath ? { tokenSegmentsRef: input.tokenSegmentsPath } : {}),
    ...(input.rewardPath ? { rewardRef: input.rewardPath } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.weightVersion ? { weightVersion: input.weightVersion } : {}),
    metadata: {
      sessionLogFile: basename(input.sessionLogPath),
      llmArtifactCount: trace.llmArtifacts.length,
      ...(input.metadata ?? {}),
    },
  })
  const sidecarPath = join(input.rootDir, 'rollouts', `${sidecar.rollout_id}.json`)
  await mkdir(join(input.rootDir, 'rollouts'), { recursive: true })
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8')
  return { sidecar, sidecarPath, traceArtifact: trace.traceArtifact }
}
