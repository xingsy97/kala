/**
 * Export OpenInference trace + LLM request/response artifacts for a session.
 * Consumes a persisted JSONL log and writes deterministic, redacted JSON files
 * into the artifact store.
 */

import { mkdir } from 'node:fs/promises'

import {
  createArtifactStore,
  exportSessionSpans,
  type ArtifactRef,
} from '@agent-kernel/shared/enhancement'

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
