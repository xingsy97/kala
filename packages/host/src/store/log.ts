/**
 * JSONL event log reader/writer.
 *
 * Append-only. Each session gets one file. Header first, events after, all
 * one JSON object per line. See `docs/protocol/event-log.md` for the spec.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'
import type {
  EventEntry,
  HeaderEntry,
  LLMTrace,
  LogEntry,
  MetadataEntry,
  SnapshotEntry,
} from '@agent-kernel/shared'
import { LOG_FORMAT_VERSION } from '@agent-kernel/shared'

const KERNEL_VERSION = '@agent-kernel/kernel@0.0.0'

export type WriteHeaderParams = {
  path: string
  sessionId: string
  config: AgentConfig
  initialState: AgentState
  parentSessionId?: string
  parentCursor?: number
  workspaceId?: string
  workspaceName?: string
  initialCwd?: string
}

export async function writeHeader(params: WriteHeaderParams): Promise<void> {
  await mkdir(dirname(params.path), { recursive: true })
  const entry: HeaderEntry = {
    kind: 'header',
    seq: 0,
    ts: new Date().toISOString(),
    sessionId: params.sessionId,
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
    ...(params.workspaceId !== undefined
      ? { workspaceId: params.workspaceId }
      : {}),
    ...(params.workspaceName !== undefined
      ? { workspaceName: params.workspaceName }
      : {}),
    ...(params.initialCwd !== undefined ? { initialCwd: params.initialCwd } : {}),
  }
  await writeFile(params.path, JSON.stringify(entry) + '\n', 'utf8')
}

export type AppendEventParams = {
  path: string
  seq: number
  event: AgentEvent
  effects: readonly Effect[]
  usage?: UsageTotal
  llmTrace?: LLMTrace
  model?: string
}

export async function appendEventEntry(
  params: AppendEventParams,
): Promise<EventEntry> {
  const entry: EventEntry = {
    kind: 'event',
    seq: params.seq,
    ts: new Date().toISOString(),
    event: params.event,
    effects: params.effects,
    ...(params.usage ? { usage: params.usage } : {}),
    ...(params.llmTrace ? { llmTrace: params.llmTrace } : {}),
    ...(params.model ? { model: params.model } : {}),
  }
  await appendFile(params.path, JSON.stringify(entry) + '\n', 'utf8')
  return entry
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
  patch: { label?: string; workspaceId?: string; workspaceName?: string },
): Promise<MetadataEntry> {
  const entry: MetadataEntry = {
    kind: 'metadata',
    ts: new Date().toISOString(),
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.workspaceId !== undefined ? { workspaceId: patch.workspaceId } : {}),
    ...(patch.workspaceName !== undefined ? { workspaceName: patch.workspaceName } : {}),
  }
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
  return entry
}

export type ParsedLog = {
  header: HeaderEntry
  events: EventEntry[]
  snapshots: SnapshotEntry[]
  metadata: MetadataEntry[]
  /**
   * Non-fatal parse warnings. Populated when the last line of the file was
   * truncated (the process crashed mid-`appendFile`). The recovered log is
   * still usable  -  the caller can decide whether to surface the warning.
   */
  warnings: readonly string[]
}

export async function readSessionLog(path: string): Promise<ParsedLog> {
  // Read as a whole file so we can tell whether the trailing byte is a
  // newline (fully-flushed line) or not (potentially truncated tail).
  const raw = await readFile(path, 'utf8')
  const endsWithNewline = raw.length === 0 || raw.endsWith('\n')
  // Splitting on \n gives us an extra empty trailing element when the file
  // ends with \n; strip it so `lines[lines.length - 1]` is always the last
  // *content* line (possibly empty for an empty file).
  const lines = raw.split('\n')
  if (endsWithNewline) lines.pop()

  const entries: LogEntry[] = []
  const warnings: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().length === 0) continue
    try {
      entries.push(JSON.parse(line) as LogEntry)
    } catch (err) {
      const isLast = i === lines.length - 1
      // A crash mid-write may leave the final line partial. That's the only
      // case we tolerate  -  corruption anywhere else is a real integrity bug
      // and MUST be surfaced.
      if (isLast && !endsWithNewline) {
        warnings.push(
          `Dropped truncated final line ${i + 1} (${line.length} bytes): ${(err as Error).message}`,
        )
        continue
      }
      throw new Error(
        `Malformed JSON at line ${i + 1}: ${(err as Error).message}`,
      )
    }
  }

  if (entries.length === 0) throw new Error(`Empty log: ${path}`)
  const header = entries[0]
  if (!header || header.kind !== 'header')
    throw new Error(`Log ${path} missing header`)

  const events: EventEntry[] = []
  const snapshots: SnapshotEntry[] = []
  const metadata: MetadataEntry[] = []
  for (const e of entries.slice(1)) {
    if (e.kind === 'event') events.push(e)
    else if (e.kind === 'snapshot') snapshots.push(e)
    else if (e.kind === 'metadata') metadata.push(e)
  }
  return { header, events, snapshots, metadata, warnings }
}
