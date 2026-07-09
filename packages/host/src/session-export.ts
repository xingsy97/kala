/**
 * Export OpenInference trace + LLM request/response artifacts for a session.
 * Consumes a persisted JSONL log and writes deterministic, redacted JSON files
 * into the artifact store.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath, sep } from 'node:path'

import {
  createArtifactStore,
  exportSessionSpans,
  type ArtifactRef,
} from '@agent-kernel/shared/enhancement'

import { readSessionLog } from './store/log.js'
import type { LLMTrace } from '@agent-kernel/shared'

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
    const trace = await loadEntryTrace(input.sessionLogPath, entry)
    if (!trace) continue
    llmArtifacts.push(await store.writeJson(
      'llm_request',
      `llm/${sessionId}/${entry.seq}.request.json`,
      trace.request,
    ))
    if (trace.response) {
      llmArtifacts.push(await store.writeJson(
        'llm_response',
        `llm/${sessionId}/${entry.seq}.response.json`,
        trace.response,
      ))
    }
  }
  return { traceArtifact, llmArtifacts, sessionId }
}

async function loadEntryTrace(
  logPath: string,
  entry: Awaited<ReturnType<typeof readSessionLog>>['events'][number],
): Promise<LLMTrace | undefined> {
  if (entry.llmTraceArtifact) {
    const base = dirname(logPath)
    const resolved = resolvePath(base, entry.llmTraceArtifact.path)
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new Error('trace artifact path escapes session directory')
    }
    return JSON.parse(await readFile(resolved, 'utf8')) as LLMTrace
  }
  return entry.llmTrace
}
