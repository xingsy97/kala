/**
 * JSONL event log reader/writer.
 *
 * Append-only. Each session gets one file. Header first, events after, all
 * one JSON object per line. See `docs/protocol/event-log.md` for the spec.
 */

import { createReadStream } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { basename, dirname, join, relative } from 'node:path'

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'
import type {
  EventEntry,
  AgentRuntimeId,
  HeaderEntry,
  LLMTrace,
  LogArtifactRef,
  LogEntry,
  MetadataEntry,
  RuntimeMetadataEntry,
  SnapshotEntry,
} from '@agent-kernel/shared'
import { LOG_FORMAT_VERSION, redactLlmTrace } from '@agent-kernel/shared'

const KERNEL_VERSION = '@agent-kernel/kernel@0.0.0'

export type WriteHeaderParams = {
  path: string
  sessionId: string
  agentRuntime?: AgentRuntimeId
  agentRuntimeVersion?: string
  externalSessionId?: string
  config: AgentConfig
  initialState: AgentState
  parentSessionId?: string
  parentCursor?: number
  parentCallId?: string
  agentType?: string
  subAgentStartedAt?: string
  workspaceId?: string
  workspaceName?: string
  initialCwd?: string
}

export async function writeHeader(params: WriteHeaderParams): Promise<HeaderEntry> {
  await mkdir(dirname(params.path), { recursive: true })
  const entry: HeaderEntry = {
    kind: 'header',
    seq: 0,
    ts: new Date().toISOString(),
    sessionId: params.sessionId,
    ...(params.agentRuntime ? { agentRuntime: params.agentRuntime } : {}),
    ...(params.agentRuntimeVersion ? { agentRuntimeVersion: params.agentRuntimeVersion } : {}),
    ...(params.externalSessionId ? { externalSessionId: params.externalSessionId } : {}),
    formatVersion: LOG_FORMAT_VERSION,
    kernelVersion: KERNEL_VERSION,
    config: params.config,
    initialState: params.initialState,
    ...(params.parentSessionId
      ? { parentSessionId: params.parentSessionId }
      : {}),
    ...(params.parentCursor !== undefined
      ? { parentCursor: params.parentCursor }
      : {}),
    ...(params.parentCallId !== undefined
      ? { parentCallId: params.parentCallId }
      : {}),
    ...(params.agentType !== undefined
      ? { agentType: params.agentType }
      : {}),
    ...(params.subAgentStartedAt !== undefined
      ? { subAgentStartedAt: params.subAgentStartedAt }
      : {}),
    ...(params.workspaceId !== undefined
      ? { workspaceId: params.workspaceId }
      : {}),
    ...(params.workspaceName !== undefined
      ? { workspaceName: params.workspaceName }
      : {}),
    ...(params.initialCwd !== undefined ? { initialCwd: params.initialCwd } : {}),
  }
  await writeFile(params.path, JSON.stringify(entry) + '\n', 'utf8')
  await maybeWriteAgentModuleArtifacts(params.path, entry)
  return entry
}

export async function readSessionHeader(path: string): Promise<HeaderEntry> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      const entry = JSON.parse(line) as LogEntry
      if (entry.kind !== 'header') throw new Error(`First log entry is not a header: ${path}`)
      return entry
    }
  } finally {
    rl.close()
  }
  throw new Error(`Session log is empty: ${path}`)
}

async function maybeWriteAgentModuleArtifacts(logPath: string, header: HeaderEntry): Promise<void> {
  if (!header.config.agentModule) return
  const root = artifactRootForLog(logPath)
  const dir = join(root, 'agent-module')
  await mkdir(dir, { recursive: true })
  if (header.config.systemPrompt) {
    await writeFile(join(dir, 'system-prompt.txt'), header.config.systemPrompt, 'utf8')
  }
  await writeFile(
    join(dir, 'tool-registry.json'),
    JSON.stringify({
      module: header.config.agentModule,
      tools: header.config.tools,
    }, null, 2) + '\n',
    'utf8',
  )
}

export type AppendEventParams = {
  path: string
  seq: number
  event: AgentEvent
  effects: readonly Effect[]
  usage?: UsageTotal
  llmTrace?: LLMTrace
  model?: string
  timing?: import('@agent-kernel/shared').EventTimingMetadata
}

export async function appendEventEntry(
  params: AppendEventParams,
): Promise<EventEntry> {
  const artifactRoot = artifactRootForLog(params.path)
  const fullEffects = params.effects
  const slimEffects = params.effects.map(slimEffect)
  const effectsArtifact = hasLargeEffectPayload(fullEffects)
    ? await writeJsonArtifact({
        logPath: params.path,
        artifactRoot,
        kind: 'effects',
        seq: params.seq,
        value: fullEffects,
      })
    : undefined
  const safeLlmTrace = params.llmTrace ? redactLlmTrace(params.llmTrace) : undefined
  const llmTraceArtifact = safeLlmTrace
    ? await writeJsonArtifact({
        logPath: params.path,
        artifactRoot,
        kind: 'llm-traces',
        seq: params.seq,
        value: safeLlmTrace,
      })
    : undefined
  const entry: EventEntry = {
    kind: 'event',
    seq: params.seq,
    ts: new Date().toISOString(),
    event: params.event,
    effects: slimEffects,
    ...(params.usage ? { usage: params.usage } : {}),
    ...(effectsArtifact ? { effectsArtifact } : {}),
    ...(safeLlmTrace ? { llmTrace: summarizeLlmTrace(safeLlmTrace) } : {}),
    ...(llmTraceArtifact ? { llmTraceArtifact } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.timing ? { timing: params.timing } : {}),
  }
  // Event entries are the authority for Session state. `appendFile()` resolving
  // only means bytes reached the kernel page cache; a crash could otherwise
  // acknowledge and broadcast an event that is absent after restart.
  await appendDurableLine(params.path, JSON.stringify(entry) + '\n')
  return entry
}

async function appendDurableLine(path: string, line: string): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(line, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function summarizeLlmTrace(trace: LLMTrace): LLMTrace {
  return {
    provider: trace.provider,
    model: trace.model,
    request: {
      url: trace.request.url,
      headers: trace.request.headers,
      body: undefined,
    },
    ...(trace.response
      ? {
          response: {
            status: trace.response.status,
            ...(trace.response.streamEventTypes ? { streamEventTypes: trace.response.streamEventTypes } : {}),
            ...(trace.response.metrics ? { metrics: trace.response.metrics } : {}),
          },
        }
      : {}),
    ...(trace.gatewayRequestId ? { gatewayRequestId: trace.gatewayRequestId } : {}),
    ...(trace.weightVersion ? { weightVersion: trace.weightVersion } : {}),
  }
}

function artifactRootForLog(logPath: string): string {
  const sessionSlug = basename(logPath, '.jsonl')
  return join(dirname(logPath), 'artifacts', sessionSlug)
}

function hasLargeEffectPayload(effects: readonly Effect[]): boolean {
  return effects.some((effect) => effect.kind === 'call_llm')
}

export function slimEffect(effect: Effect): Effect {
  if (effect.kind === 'call_llm') return { kind: 'call_llm', messages: [], tools: [] }
  if (effect.kind === 'call_tool') {
    return {
      kind: 'call_tool',
      callId: effect.callId,
      name: effect.name,
      input: effect.input,
      ...(effect.cwd ? { cwd: effect.cwd } : {}),
    }
  }
  if (effect.kind === 'request_approval') {
    return {
      kind: 'request_approval',
      callId: effect.callId,
      name: effect.name,
      input: effect.input,
    }
  }
  return effect
}

async function writeJsonArtifact(params: {
  logPath: string
  artifactRoot: string
  kind: 'effects' | 'llm-traces'
  seq: number
  value: unknown
}): Promise<LogArtifactRef> {
  const dir = join(params.artifactRoot, params.kind)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${String(params.seq).padStart(8, '0')}.json`)
  const json = JSON.stringify(params.value)
  await writeFile(path, json + '\n', 'utf8')
  return {
    path: relative(dirname(params.logPath), path),
    bytes: Buffer.byteLength(json) + 1,
    sha256: createHash('sha256').update(json).update('\n').digest('hex'),
  }
}

export async function appendSnapshotEntry(
  path: string,
  seq: number,
  state: AgentState,
): Promise<SnapshotEntry> {
  const entry: SnapshotEntry = {
    kind: 'snapshot',
    seq,
    ts: new Date().toISOString(),
    state,
  }
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

export async function appendMetadataEntry(
  path: string,
  patch: { label?: string; workspaceId?: string; workspaceName?: string; selectedModel?: string; toolCardMode?: 'dots' | 'standard' },
): Promise<MetadataEntry> {
  const entry: MetadataEntry = {
    kind: 'metadata',
    ts: new Date().toISOString(),
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.workspaceId !== undefined ? { workspaceId: patch.workspaceId } : {}),
    ...(patch.workspaceName !== undefined ? { workspaceName: patch.workspaceName } : {}),
    ...(patch.selectedModel !== undefined ? { selectedModel: patch.selectedModel } : {}),
    ...(patch.toolCardMode !== undefined ? { toolCardMode: patch.toolCardMode } : {}),
  }
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

export async function appendRuntimeMetadataEntry(
  path: string,
  input: {
    sessionId: string
    action: string
    payload: Record<string, unknown>
    artifactRef?: LogArtifactRef
  },
): Promise<RuntimeMetadataEntry> {
  const entry: RuntimeMetadataEntry = {
    kind: 'runtime_metadata',
    ts: new Date().toISOString(),
    sessionId: input.sessionId,
    action: input.action,
    payload: input.payload,
    ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
  }
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

export type ParsedLog = {
  header: HeaderEntry
  events: EventEntry[]
  snapshots: SnapshotEntry[]
  metadata: MetadataEntry[]
  runtimeMetadata: RuntimeMetadataEntry[]
  /**
   * Non-fatal parse warnings. Populated when the last line of the file was
   * truncated (the process crashed mid-`appendFile`). The recovered log is
   * still usable — the caller can decide whether to surface the warning.
   */
  warnings: readonly string[]
}

export async function readSessionLog(path: string): Promise<ParsedLog> {
  const entries: LogEntry[] = []
  const warnings: string[] = []
  const endsWithNewline = await fileEndsWithNewline(path)
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let lineNo = 0
  let pendingLine: string | undefined
  let pendingLineNo = 0
  for await (const line of rl) {
    lineNo += 1
    if (pendingLine !== undefined) {
      parseLogLine(pendingLine, pendingLineNo, entries)
      pendingLine = undefined
    }
    try {
      pendingLine = line
      pendingLineNo = lineNo
    } catch (err) {
      throw new Error(
        `Malformed JSON at line ${lineNo}: ${(err as Error).message}`,
      )
    }
  }
  if (pendingLine !== undefined) {
    try {
      parseLogLine(pendingLine, pendingLineNo, entries)
    } catch (err) {
      if (!endsWithNewline) {
        warnings.push(
          `Dropped truncated final line ${pendingLineNo} (${pendingLine.length} bytes): ${(err as Error).message}`,
        )
      } else {
        throw err
      }
    }
  }

  if (entries.length === 0) throw new Error(`Empty log: ${path}`)
  const header = entries[0]
  if (!header || header.kind !== 'header')
    throw new Error(`Log ${path} missing header`)

  const events: EventEntry[] = []
  let lastRawEventSeq = header.initialState.cursor
  let canonicalEventSeq = header.initialState.cursor
  const snapshots: SnapshotEntry[] = []
  const metadata: MetadataEntry[] = []
  const runtimeMetadata: RuntimeMetadataEntry[] = []
  for (const e of entries.slice(1)) {
    if (e.kind === 'event') {
      if (!Number.isSafeInteger(e.seq) || e.seq <= 0) {
        warnings.push(`Dropped event with invalid sequence ${String(e.seq)}`)
        continue
      }
      canonicalEventSeq += 1
      if (e.seq !== lastRawEventSeq + 1) {
        // A historical graceful-restart bug could start the replacement Host
        // before the previous process had fully stopped. The replacement loaded
        // an older cursor and then durably appended valid transitions with reused
        // sequence numbers. Dropping those entries loses real user messages on
        // every reload. JSONL append order is the final authority: preserve every
        // valid event and repair only its in-memory cursor for fold/history.
        warnings.push(`Repaired event sequence ${e.seq} to ${canonicalEventSeq} after ${lastRawEventSeq}`)
      }
      lastRawEventSeq = e.seq
      events.push(e.seq === canonicalEventSeq ? e : { ...e, seq: canonicalEventSeq })
    }
    else if (e.kind === 'snapshot') snapshots.push(e)
    else if (e.kind === 'metadata') metadata.push(e)
    else if (e.kind === 'runtime_metadata') runtimeMetadata.push(e)
  }
  return { header, events, snapshots, metadata, runtimeMetadata, warnings }
}

function parseLogLine(line: string, lineNo: number, entries: LogEntry[]): void {
  if (line.trim().length === 0) return
  try {
    entries.push(JSON.parse(line) as LogEntry)
  } catch (err) {
    throw new Error(`Malformed JSON at line ${lineNo}: ${(err as Error).message}`)
  }
}

async function fileEndsWithNewline(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size === 0) return true
    const buf = Buffer.alloc(1)
    await handle.read(buf, 0, 1, stat.size - 1)
    return buf[0] === 10
  } finally {
    await handle.close()
  }
}
