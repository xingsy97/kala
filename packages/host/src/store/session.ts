/**
 * Session store. In-memory map of live sessions + append-only JSONL log per
 * session on disk. The log is the source of truth; the in-memory record is
 * a cache for hot access.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  Message,
  MessageContent,
  UsageTotal,
} from '@agent-kernel/kernel'
import type {
  AgentRuntimeId,
  ContextUsageSnapshot,
  EventEntry,
  LLMTrace,
  SessionMemoryPolicy,
  SessionPreferences,
  SnapshotEntry,
} from '@agent-kernel/shared'
import { createInitialState, fold } from '@agent-kernel/kernel'
import type { SessionSummary } from '@agent-kernel/shared'
import { ulid } from 'ulid'

import {
  appendEventEntry,
  appendMetadataEntry,
  appendRuntimeMetadataEntry,
  appendSnapshotEntry,
  findLatestEventEntry,
  findLatestRuntimeMetadata,
  readLastSessionSnapshot,
  readRecentSessionMetadata,
  readSessionHeader,
  readSessionLog,
  readSessionState,
  snapshotSidecarPath,
  writeHeader,
} from './log.js'
import { step } from '@agent-kernel/kernel'
import { toolLockFor } from '../tool-version.js'
import { writeJsonFile } from '../tenant-runtime/atomic-json-file.js'

export type SessionRecord = {
  readonly sessionId: string
  readonly agentRuntime: AgentRuntimeId
  readonly agentRuntimeVersion?: string
  readonly externalSessionId?: string
  readonly logPath: string
  readonly createdAt: string
  readonly config: AgentConfig
  readonly toolLock: Readonly<Record<string, { version: string; schemaHash: string | null }>>
  readonly parentSessionId?: string
  readonly parentCursor?: number
  readonly parentCallId?: string
  readonly agentType?: string
  readonly subAgentStartedAt?: string
  readonly workspaceId?: string
  readonly workspaceName?: string
  readonly organizationId?: string
  readonly principal?: string
  readonly organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  lastEventAt?: string
  /** Durable timestamp of the latest committed user turn; projected by the Host. */
  turnStartedAt?: string
  state: AgentState
  /** Stable default title captured from the first persisted user_message event. */
  firstUserMessage?: string
  /**
   * Operator-set display label from the most recent `client:rename_session`.
   * Loaded from the last MetadataEntry in the JSONL and updated in place
   * whenever the host writes a new metadata line.
   */
  label?: string
  preferences: SessionPreferences
  /** Last provider-reported context usage for external runtimes. */
  runtimeContextSnapshot?: ContextUsageSnapshot
  /**
   * Host-side memory policy for this session. When `mode: 'disabled'`, the
   * loop rejects `memory` tool calls to workspace/global scope so an isolated
   * session cannot inadvertently pull cross-task state from disk. Not part of
   * kernel state — the reducer never sees it and it is never persisted into
   * the JSONL ledger. Callers attach it via
   * `CreateSessionParams.memoryPolicy`.
   */
  memoryPolicy?: SessionMemoryPolicy
}

const EXTERNAL_RUNTIME_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
// Leave room for the SnapshotEntry envelope (`kind`, `seq`, `ts`, and `state`).
const EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES = EXTERNAL_RUNTIME_SNAPSHOT_MAX_BYTES - 1024
const EXTERNAL_RUNTIME_CONTENT_MAX_BYTES = 32 * 1024
const EXTERNAL_RUNTIME_TEXT_MAX_BYTES = 128 * 1024
const EXTERNAL_RUNTIME_INPUT_MAX_BYTES = 32 * 1024

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value))
}

function truncateUtf8(value: string, maxBytes: number, suffix: string): string {
  if (utf8Bytes(value) <= maxBytes) return value
  const suffixBytes = utf8Bytes(suffix)
  const headBytes = Math.max(0, maxBytes - suffixBytes)
  return Buffer.from(value, 'utf8').subarray(0, headBytes).toString('utf8') + suffix
}

function compactLargeString(value: string, maxBytes: number, label: string): string {
  const bytes = utf8Bytes(value)
  if (bytes <= maxBytes) return value
  const overflowIndex = value.lastIndexOf('--- output truncated:')
  const overflowMarker = overflowIndex >= 0 ? value.slice(overflowIndex) : undefined
  const suffix = overflowMarker && utf8Bytes(overflowMarker) < 4096
    ? `\n\n${overflowMarker}`
    : `\n\n--- ${label} compacted in projection snapshot: original ${bytes} bytes ---`
  const body = overflowMarker ? value.slice(0, overflowIndex).trimEnd() : value
  return truncateUtf8(body, maxBytes, suffix)
}

function compactToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const bytes = jsonBytes(input)
  if (bytes <= EXTERNAL_RUNTIME_INPUT_MAX_BYTES) return input
  return {
    __snapshotCompacted: true,
    originalBytes: bytes,
    preview: truncateUtf8(
      JSON.stringify(input),
      EXTERNAL_RUNTIME_INPUT_MAX_BYTES,
      `\n--- tool input compacted in projection snapshot: original ${bytes} bytes ---`,
    ),
  }
}

function compactSnapshotContent(content: MessageContent, aggressive: boolean): MessageContent {
  if (content.type === 'tool_result') {
    const maxBytes = aggressive ? 4096 : EXTERNAL_RUNTIME_CONTENT_MAX_BYTES
    return {
      ...content,
      content: compactLargeString(content.content, maxBytes, 'tool result'),
    }
  }
  if (content.type === 'tool_call') {
    return {
      ...content,
      input: compactToolInput(content.input),
    }
  }
  if (content.type === 'text') {
    const maxBytes = aggressive ? 8192 : EXTERNAL_RUNTIME_TEXT_MAX_BYTES
    return {
      ...content,
      text: compactLargeString(content.text, maxBytes, 'text content'),
    }
  }
  if (content.type === 'thinking') {
    const maxBytes = aggressive ? 4096 : EXTERNAL_RUNTIME_TEXT_MAX_BYTES
    return {
      ...content,
      text: compactLargeString(content.text, maxBytes, 'reasoning content'),
    }
  }
  if (content.type === 'file' && 'data' in content && utf8Bytes(content.data) > EXTERNAL_RUNTIME_CONTENT_MAX_BYTES) {
    return {
      ...content,
      data: '',
      mediaType: 'text/plain',
      name: `${content.name}.snapshot-compacted`,
    }
  }
  if (content.type === 'image' && content.source.kind === 'base64' && utf8Bytes(content.source.data) > EXTERNAL_RUNTIME_CONTENT_MAX_BYTES) {
    return {
      ...content,
      source: {
        ...content.source,
        data: '',
      },
    }
  }
  return content
}

function compactSnapshotMessage(message: Message, aggressive: boolean): Message {
  return {
    ...message,
    content: message.content.map((content) => compactSnapshotContent(content, aggressive)),
  }
}

const SNAPSHOT_PLACEHOLDER = 'compacted in projection snapshot'

function isRealUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false
  return message.content.some((content) =>
    content.type !== 'text'
    || (content.text.trim().length > 0 && !content.text.includes(SNAPSHOT_PLACEHOLDER)),
  )
}

function normalizeToolPairs(messages: readonly Message[], pendingCallIds: ReadonlySet<string>): Message[] {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call') callIds.add(content.callId)
      else if (content.type === 'tool_result') resultIds.add(content.callId)
    }
  }
  const pairedCallIds = new Set([...callIds].filter((callId) => resultIds.has(callId)))
  return messages.flatMap((message) => {
    const content = message.content.filter((item) => {
      if (item.type === 'tool_result') return pairedCallIds.has(item.callId)
      if (item.type === 'tool_call') return pairedCallIds.has(item.callId) || pendingCallIds.has(item.callId)
      return true
    })
    return content.length > 0 ? [{ ...message, content }] : []
  })
}

function relatedMessageIndices(messages: readonly Message[]): Map<number, ReadonlySet<number>> {
  const indicesByCallId = new Map<string, Set<number>>()
  for (const [index, message] of messages.entries()) {
    for (const content of message.content) {
      if (content.type !== 'tool_call' && content.type !== 'tool_result') continue
      const indices = indicesByCallId.get(content.callId) ?? new Set<number>()
      indices.add(index)
      indicesByCallId.set(content.callId, indices)
    }
  }
  const related = new Map<number, Set<number>>()
  for (const indices of indicesByCallId.values()) {
    for (const index of indices) {
      const set = related.get(index) ?? new Set<number>([index])
      for (const relatedIndex of indices) set.add(relatedIndex)
      related.set(index, set)
    }
  }
  return related
}

function compactPendingCalls(state: AgentState, aggressive: boolean): AgentState {
  if (state.pendingCalls.length === 0) return state
  return {
    ...state,
    pendingCalls: state.pendingCalls.map((call) => ({
      ...call,
      input: aggressive ? { __snapshotCompacted: true } : compactToolInput(call.input),
    })),
  } as AgentState
}

export function compactExternalRuntimeSnapshotState(state: AgentState): AgentState {
  const pendingCallIds = new Set(state.pendingCalls.map((call) => call.callId))
  let messages = normalizeToolPairs(
    state.messages.map((message) => compactSnapshotMessage(message, false)),
    pendingCallIds,
  )
  let base = compactPendingCalls(state, false)
  let candidate = { ...base, messages } as AgentState
  if (jsonBytes(candidate) <= EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES) return candidate

  messages = normalizeToolPairs(
    state.messages.map((message) => compactSnapshotMessage(message, true)),
    pendingCallIds,
  )
  base = compactPendingCalls(state, true)
  candidate = { ...base, messages } as AgentState
  if (jsonBytes(candidate) <= EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES) return candidate

  const firstUserIndex = messages.findIndex(isRealUserMessage)
  const related = relatedMessageIndices(messages)
  const selected = new Set<number>()
  const rejected = new Set<number>()
  const messageBytes = messages.map(jsonBytes)
  const emptyStateBytes = jsonBytes({ ...base, messages: [] })
  let selectedMessageBytes = 0
  const relatedClosure = (index: number): Set<number> => {
    const closure = new Set<number>()
    const pending = [index]
    while (pending.length > 0) {
      const next = pending.pop()!
      if (closure.has(next)) continue
      closure.add(next)
      for (const relatedIndex of related.get(next) ?? []) pending.push(relatedIndex)
    }
    return closure
  }
  const trySelect = (index: number, required: boolean): void => {
    const closure = relatedClosure(index)
    const added = [...closure].filter((relatedIndex) => !selected.has(relatedIndex))
    const nextMessageBytes = selectedMessageBytes
      + added.reduce((total, relatedIndex) => total + messageBytes[relatedIndex]!, 0)
    const nextCount = selected.size + added.length
    const estimatedBytes = emptyStateBytes + nextMessageBytes + Math.max(0, nextCount - 1)
    if (required || estimatedBytes <= EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES) {
      for (const relatedIndex of added) selected.add(relatedIndex)
      selectedMessageBytes = nextMessageBytes
    } else {
      for (const relatedIndex of closure) rejected.add(relatedIndex)
    }
  }
  if (firstUserIndex >= 0) trySelect(firstUserIndex, true)

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.has(index) || rejected.has(index)) continue
    trySelect(index, false)
  }

  candidate = {
    ...base,
    messages: messages.filter((_, index) => selected.has(index)),
  } as AgentState
  if (jsonBytes(candidate) <= EXTERNAL_RUNTIME_SNAPSHOT_STATE_MAX_BYTES) return candidate

  throw new Error('External runtime snapshot cannot be compacted below 2 MiB without losing live state')
}

async function optionalSnapshot(path: string): Promise<SnapshotEntry[]> {
  const snapshot = await readLastSessionSnapshot(path)
  return snapshot ? [snapshot] : []
}

export type CreateSessionParams = {
  systemPrompt?: string
  config: AgentConfig
  agentRuntime?: AgentRuntimeId
  agentRuntimeVersion?: string
  externalSessionId?: string
  parentSessionId?: string
  parentCursor?: number
  parentCallId?: string
  agentType?: string
  subAgentStartedAt?: string
  initialState?: AgentState
  sessionId?: string
  workspaceId?: string
  workspaceName?: string
  organizationId?: string
  principal?: string
  organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  initialCwd?: string
  initialApprovalMode?: import('@agent-kernel/kernel').ApprovalMode
  memoryPolicy?: SessionMemoryPolicy
  preferences?: SessionPreferences
}

export type SessionStoreOptions = {
  runtimeConfig?: AgentConfig | (() => AgentConfig)
  /** Root used by Host-side artifacts that partition data by Session ID. */
  artifactRootDir?: string | false
  /** Removes registry-backed Session artifacts that live outside artifactRootDir. */
  deleteRegisteredArtifacts?(sessionId: string): Promise<void>
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

const SESSION_ARTIFACT_KINDS = [
  'message-assembly',
  'router-decisions',
  'tool-catalog',
  'compaction-summaries',
  'subagent-policies',
] as const

export class SessionStore {
  private readonly records = new Map<string, SessionRecord>()
  private readonly summaryCache = new Map<string, CachedSessionSummary>()
  private readonly summaryLoads = new Map<string, {
    mtimeMs: number
    size: number
    promise: Promise<SessionSummary>
  }>()
  /**
   * De-duplicates concurrent `ensure` / `load` requests for the same
   * sessionId. Two dashboard + executor sockets arriving for a fresh
   * session in the same tick previously raced through
   * `get → load(fail) → create` and produced two log files on disk. The
   * in-flight map guarantees only one `create()` per sessionId.
   */
  private readonly inFlight = new Map<string, Promise<SessionRecord>>()
  private readonly runtimeRecoveries = new Map<string, Promise<void>>()
  private readonly locallyProjectedExternalSessions = new Set<string>()
  /**
   * Last-resort per-Session commit lock. HostLoop normally serializes turns, but
   * cancellation, recovery and administrative paths have historically reached
   * `record()` concurrently. The store is the final authority and must reject
   * stale caller-computed states rather than append duplicate cursor values.
   */
  private readonly recordTails = new Map<string, Promise<void>>()

  constructor(private readonly sessionsDir: string, private readonly options: SessionStoreOptions = {}) {
    mkdirSync(this.sessionsDir, { recursive: true })
  }

  get dir(): string {
    return this.sessionsDir
  }

  async create(params: CreateSessionParams): Promise<SessionRecord> {
    const sessionId = params.sessionId ?? ulid()
    const initialState =
      params.initialState ??
      createInitialState({
        sessionId,
        systemPrompt: params.systemPrompt ?? params.config.systemPrompt,
      })
    const stateForSession: AgentState =
      initialState.sessionId === sessionId
        ? initialState
        : { ...initialState, sessionId }
    const stateWithCwd: AgentState = params.initialCwd
      ? { ...stateForSession, cwd: params.initialCwd }
      : stateForSession
    const stateWithApproval: AgentState = params.initialApprovalMode
      ? { ...stateWithCwd, approvalMode: params.initialApprovalMode }
      : stateWithCwd
    const logPath = this.pathFor(sessionId)
    const header = await writeHeader({
      path: logPath,
      sessionId,
      agentRuntime: params.agentRuntime ?? 'kernel',
      ...(params.agentRuntimeVersion ? { agentRuntimeVersion: params.agentRuntimeVersion } : {}),
      ...(params.externalSessionId ? { externalSessionId: params.externalSessionId } : {}),
      config: params.config,
      initialState: stateWithApproval,
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
      ...(params.organizationId !== undefined
        ? { organizationId: params.organizationId }
        : {}),
      ...(params.principal !== undefined
        ? { principal: params.principal }
        : {}),
      ...(params.organizationRole !== undefined
        ? { organizationRole: params.organizationRole }
        : {}),
      ...(params.initialCwd !== undefined
        ? { initialCwd: params.initialCwd }
        : {}),
    })
    const record: SessionRecord = {
      sessionId,
      agentRuntime: params.agentRuntime ?? 'kernel',
      ...(params.agentRuntimeVersion ? { agentRuntimeVersion: params.agentRuntimeVersion } : {}),
      ...(params.externalSessionId ? { externalSessionId: params.externalSessionId } : {}),
      logPath,
      createdAt: header.ts,
      config: params.config,
      toolLock: toolLockFor(params.config),
      state: stateWithApproval,
      preferences: normalizedPreferences(params.preferences),
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
      ...(params.organizationId !== undefined
        ? { organizationId: params.organizationId }
        : {}),
      ...(params.principal !== undefined
        ? { principal: params.principal }
        : {}),
      ...(params.organizationRole !== undefined
        ? { organizationRole: params.organizationRole }
        : {}),
      ...(params.memoryPolicy !== undefined
        ? { memoryPolicy: params.memoryPolicy }
        : {}),
    }
    if (record.preferences.selectedModel) {
      await appendMetadataEntry(record.logPath, { selectedModel: record.preferences.selectedModel })
    }
    if (record.preferences.toolCardMode) {
      await appendMetadataEntry(record.logPath, { toolCardMode: record.preferences.toolCardMode })
    }
    this.records.set(sessionId, record)
    this.summaryCache.delete(logPath)
    return record
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId)
  }

  recordsSnapshot(): readonly SessionRecord[] {
    return [...this.records.values()]
  }

  updateConfig(sessionId: string, update: (config: AgentConfig) => AgentConfig): void {
    const rec = this.records.get(sessionId)
    if (!rec) return
    ;(rec as { config: AgentConfig }).config = update(rec.config)
  }

  async updatePreferences(sessionId: string, patch: SessionPreferences): Promise<SessionPreferences> {
    const rec = this.records.get(sessionId) ?? (await this.load(sessionId))
    const next: SessionPreferences = { ...rec.preferences }
    let changed = false
    if ('selectedModel' in patch) {
      const selectedModel = normalizePreferenceString(patch.selectedModel)
      if (selectedModel === undefined) delete next.selectedModel
      else next.selectedModel = selectedModel
      changed = true
    }
    if ('toolCardMode' in patch) {
      if (patch.toolCardMode === undefined) delete next.toolCardMode
      else next.toolCardMode = patch.toolCardMode
      changed = true
    }
    if (changed) {
      rec.preferences = next
      await appendMetadataEntry(rec.logPath, {
        ...('selectedModel' in patch ? { selectedModel: next.selectedModel ?? '' } : {}),
        ...('toolCardMode' in patch && next.toolCardMode ? { toolCardMode: next.toolCardMode } : {}),
      })
      this.summaryCache.delete(rec.logPath)
    }
    return next
  }

  async load(sessionId: string, options: { recoverDangling?: boolean; runtimeConfig?: AgentConfig } = {}): Promise<SessionRecord> {
    const recoverDangling = options.recoverDangling !== false
    const cached = this.records.get(sessionId)
    if (cached) {
      if (recoverDangling) await this.recoverCachedExternalRuntime(cached)
      this.applyRuntimeConfig(cached, this.resolveRuntimeConfig(options.runtimeConfig))
      return cached
    }
    const inflight = recoverDangling ? this.inFlight.get(sessionId) : undefined
    if (inflight) {
      const record = await inflight
      this.applyRuntimeConfig(record, this.resolveRuntimeConfig(options.runtimeConfig))
      return record
    }
    const promise = this.loadInner(sessionId, { recoverDangling, runtimeConfig: this.resolveRuntimeConfig(options.runtimeConfig) }).finally(() => {
      this.inFlight.delete(sessionId)
    })
    if (recoverDangling) this.inFlight.set(sessionId, promise)
    return promise
  }

  private async recoverCachedExternalRuntime(record: SessionRecord): Promise<void> {
    if (this.locallyProjectedExternalSessions.has(record.sessionId)) return
    const existing = this.runtimeRecoveries.get(record.sessionId)
    if (existing) {
      await existing
      return
    }
    if (record.agentRuntime === 'kernel') return

    const recovery = (async () => {
      const latest = this.records.get(record.sessionId) ?? record
      const persistedSummary = await readPersistedSummary(latest.logPath)
      const latestQuarantine = await findLatestRuntimeMetadata(latest.logPath, 'runtime.quarantined_kernel_events', { maxScanBytes: 64 * 1024 * 1024 })
      const latestForeignEvent = latestQuarantine ? undefined : await findLatestEventEntry(latest.logPath, { maxScanBytes: 64 * 1024 * 1024 })
      const alreadyQuarantined = persistedSummary?.externalRuntimeAlreadyQuarantined === true || latestQuarantine !== undefined
      const contaminatedEventCount = alreadyQuarantined ? 0 : latestForeignEvent ? 1 : 0
      const next = contaminatedEventCount > 0
        ? quarantinedExternalRuntimeState(latest.state)
        : interruptedExternalRuntimeState(latest.agentRuntime, latest.state)
      if (!next) return
      await this.recordRuntimeProjection(
        latest.sessionId,
        next,
        contaminatedEventCount > 0
          ? 'runtime.quarantined_kernel_events'
          : 'copilot.recovered_interrupted_turn',
        contaminatedEventCount > 0
          ? { eventCount: contaminatedEventCount }
          : { pendingCallCount: latest.state.pendingCalls.length },
      )
    })()
    this.runtimeRecoveries.set(record.sessionId, recovery)
    try {
      await recovery
    } finally {
      if (this.runtimeRecoveries.get(record.sessionId) === recovery) {
        this.runtimeRecoveries.delete(record.sessionId)
      }
    }
  }

  private async loadInner(sessionId: string, options: { recoverDangling: boolean; runtimeConfig?: AgentConfig }): Promise<SessionRecord> {
    const path = this.pathFor(sessionId)
    if (!existsSync(path)) {
      const found = this.findLogByPrefix(sessionId)
      if (!found) throw new SessionNotFoundError(sessionId)
      return this.loadFromFile(sessionId, found, options)
    }
    return this.loadFromFile(sessionId, path, options)
  }

  async recoverInterruptedLlm(sessionId: string): Promise<{
    record: SessionRecord
    event: AgentEvent
    effects: readonly Effect[]
  } | null> {
    const record = this.records.get(sessionId) ?? (await this.load(sessionId))
    if (record.state.status !== 'thinking' || record.state.pendingCalls.length > 0) {
      return null
    }
    const recovered = await this.appendInterruptedLlmRecovery(record)
    return recovered ? { record, ...recovered } : null
  }

  /**
   * Get an existing session (from cache or disk), or create it if unknown.
   * All work for a given sessionId is serialised so N concurrent callers
   * see exactly one create + one record installation. This is the primary
   * entrypoint for connection handlers; `create` / `load` are lower-level
   * building blocks retained for tests and explicit fork flows.
   *
   * Returns `created: true` iff `ensure` had to synthesize a new record
   * (no in-memory cache hit and no log on disk). The caller uses this to
   * fan out a `server:sessions` refresh to connected dashboards without
   * every store hit spamming a broadcast.
   */
  async ensure(params: {
    sessionId: string
    agentRuntime?: AgentRuntimeId
    agentRuntimeVersion?: string
    externalSessionId?: string
    defaultConfig: AgentConfig
    workspaceId?: string
    workspaceName?: string
    organizationId?: string
    principal?: string
    organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
    initialCwd?: string
    preferences?: SessionPreferences
    runtimeConfig?: AgentConfig
  }): Promise<{ record: SessionRecord; created: boolean }> {
    const cached = this.records.get(params.sessionId)
    if (cached) {
      this.applyRuntimeConfig(cached, this.resolveRuntimeConfig(params.runtimeConfig ?? params.defaultConfig))
      await this.applyMissingCreateMetadata(cached, params)
      return { record: cached, created: false }
    }
    const inflight = this.inFlight.get(params.sessionId)
    if (inflight) {
      const record = await inflight
      this.applyRuntimeConfig(record, this.resolveRuntimeConfig(params.runtimeConfig ?? params.defaultConfig))
      await this.applyMissingCreateMetadata(record, params)
      return { record, created: false }
    }
    let created = false
    const promise = this.ensureInner(
      params.sessionId,
      params.defaultConfig,
      params.workspaceId,
      params.workspaceName,
      params.organizationId,
      params.principal,
      params.organizationRole,
      params.initialCwd,
      params.preferences,
      params.agentRuntime,
      params.agentRuntimeVersion,
      params.externalSessionId,
      this.resolveRuntimeConfig(params.runtimeConfig) ?? params.defaultConfig,
      () => { created = true },
    ).finally(() => {
      this.inFlight.delete(params.sessionId)
    })
    this.inFlight.set(params.sessionId, promise)
    const record = await promise
    return { record, created }
  }

  private async ensureInner(
    sessionId: string,
    defaultConfig: AgentConfig,
    workspaceId: string | undefined,
    workspaceName: string | undefined,
    organizationId: string | undefined,
    principal: string | undefined,
    organizationRole: 'owner' | 'admin' | 'member' | 'viewer' | undefined,
    initialCwd: string | undefined,
    preferences: SessionPreferences | undefined,
    agentRuntime: AgentRuntimeId | undefined,
    agentRuntimeVersion: string | undefined,
    externalSessionId: string | undefined,
    runtimeConfig: AgentConfig,
    markCreated: () => void,
  ): Promise<SessionRecord> {
    try {
      const record = await this.loadInner(sessionId, { recoverDangling: true, runtimeConfig })
      await this.applyMissingCreateMetadata(record, {
        sessionId,
        defaultConfig,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(organizationId !== undefined ? { organizationId } : {}),
        ...(principal !== undefined ? { principal } : {}),
        ...(organizationRole !== undefined ? { organizationRole } : {}),
        ...(initialCwd !== undefined ? { initialCwd } : {}),
        ...(preferences !== undefined ? { preferences } : {}),
      })
      return record
    } catch {
      // No existing log — create a fresh one. `create` itself performs a
      // single writeHeader() which is the atomic commit point; if it
      // throws the sessionId stays uninstalled and the next caller can
      // retry.
      markCreated()
      return await this.create({
        sessionId,
        config: defaultConfig,
        ...(agentRuntime ? { agentRuntime } : {}),
        ...(agentRuntimeVersion ? { agentRuntimeVersion } : {}),
        ...(externalSessionId ? { externalSessionId } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(organizationId !== undefined ? { organizationId } : {}),
        ...(principal !== undefined ? { principal } : {}),
        ...(organizationRole !== undefined ? { organizationRole } : {}),
        ...(initialCwd !== undefined ? { initialCwd } : {}),
        ...(preferences !== undefined ? { preferences } : {}),
      })
    }
  }

  private applyRuntimeConfig(record: SessionRecord, runtimeConfig: AgentConfig | undefined): void {
    if (!runtimeConfig) return
    ;(record as { config: AgentConfig }).config = runtimeConfig
  }

  private resolveRuntimeConfig(override?: AgentConfig): AgentConfig | undefined {
    if (override) return override
    const configured = this.options.runtimeConfig
    if (!configured) return undefined
    return typeof configured === 'function' ? configured() : configured
  }

  private async applyMissingCreateMetadata(
    record: SessionRecord,
    params: {
      sessionId: string
      defaultConfig: AgentConfig
      workspaceId?: string
      workspaceName?: string
      organizationId?: string
      principal?: string
      organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
      initialCwd?: string
    },
  ): Promise<void> {
    if (record.sessionId !== params.sessionId) return
    let metadataChanged = false
    if (record.workspaceId === undefined && params.workspaceId !== undefined) {
      ;(record as { workspaceId?: string }).workspaceId = params.workspaceId
      metadataChanged = true
    }
    if (record.workspaceName === undefined && params.workspaceName !== undefined) {
      ;(record as { workspaceName?: string }).workspaceName = params.workspaceName
      metadataChanged = true
    }
    if (record.organizationId === undefined && params.organizationId !== undefined) {
      ;(record as { organizationId?: string }).organizationId = params.organizationId
      metadataChanged = true
    }
    if (record.principal === undefined && params.principal !== undefined) {
      ;(record as { principal?: string }).principal = params.principal
      metadataChanged = true
    }
    if (record.organizationRole === undefined && params.organizationRole !== undefined) {
      ;(record as { organizationRole?: 'owner' | 'admin' | 'member' | 'viewer' }).organizationRole = params.organizationRole
      metadataChanged = true
    }
    if (metadataChanged) {
      await appendMetadataEntry(record.logPath, {
        ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
        ...(record.workspaceName !== undefined ? { workspaceName: record.workspaceName } : {}),
        ...(record.organizationId !== undefined ? { organizationId: record.organizationId } : {}),
        ...(record.principal !== undefined ? { principal: record.principal } : {}),
        ...(record.organizationRole !== undefined ? { organizationRole: record.organizationRole } : {}),
      })
      this.summaryCache.delete(record.logPath)
    }
    if (record.state.cwd === undefined && params.initialCwd !== undefined) {
      const event: AgentEvent = { kind: 'cwd_changed', cwd: params.initialCwd }
      const { next, effects } = step(record.state, event, record.config)
      const entry = await appendEventEntry({
        path: record.logPath,
        seq: next.cursor,
        event,
        effects,
      })
      record.state = next
      record.lastEventAt = entry.ts
      this.summaryCache.delete(record.logPath)
    }
  }

  async record(
    sessionId: string,
    event: AgentEvent,
    effects: readonly Effect[],
    nextState: AgentState,
    usageDelta?: UsageTotal,
    llmTrace?: LLMTrace,
    model?: string,
    timing?: import('@agent-kernel/shared').EventTimingMetadata,
  ): Promise<void> {
    const previous = this.recordTails.get(sessionId) ?? Promise.resolve()
    const commit = previous.catch(() => undefined).then(async () => {
      const rec = this.records.get(sessionId)
      if (!rec) throw new Error(`Cannot record on unknown session: ${sessionId}`)
      const expectedCursor = rec.state.cursor + 1
      if (nextState.cursor !== expectedCursor) {
        throw new Error(
          `stale Session transition for ${sessionId}: expected cursor ${expectedCursor}, received ${nextState.cursor}`,
        )
      }

      const entry = await appendEventEntry({
        path: rec.logPath,
        seq: nextState.cursor,
        event,
        effects,
        ...(usageDelta ? { usage: usageDelta } : {}),
        ...(llmTrace ? { llmTrace } : {}),
        ...(model ? { model } : {}),
        ...(timing ? { timing } : {}),
      })
      // Publish in-memory state only after the durable append and fsync succeed.
      rec.state = nextState
      rec.lastEventAt = entry.ts
      if (event.kind === 'user_message') {
        rec.turnStartedAt = validTimestamp(timing?.turnStartedAt) ?? entry.ts
      }
      if (event.kind === 'user_message' && event.text?.trim() && !rec.firstUserMessage) {
        rec.firstUserMessage = event.text
      }
      this.summaryCache.delete(rec.logPath)
    })
    this.recordTails.set(sessionId, commit)
    try {
      await commit
    } finally {
      if (this.recordTails.get(sessionId) === commit) this.recordTails.delete(sessionId)
    }
  }

  async recordRuntimeProjection(
    sessionId: string,
    nextState: AgentState,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const previous = this.recordTails.get(sessionId) ?? Promise.resolve()
    const commit = previous.catch(() => undefined).then(async () => {
      const rec = this.records.get(sessionId)
      if (!rec) throw new Error(`Cannot record projection on unknown session: ${sessionId}`)
      if (rec.agentRuntime === 'kernel') {
        throw new Error(`Kernel session ${sessionId} cannot record an external runtime projection`)
      }
      const expectedCursor = rec.state.cursor + 1
      if (nextState.cursor !== expectedCursor) {
        throw new Error(
          `stale runtime projection for ${sessionId}: expected cursor ${expectedCursor}, received ${nextState.cursor}`,
        )
      }
      const metadataEntry = await appendRuntimeMetadataEntry(rec.logPath, {
        sessionId,
        action,
        payload: { ...payload, projectionCursor: nextState.cursor },
      })
      const entry = await appendSnapshotEntry(rec.logPath, nextState.cursor, compactExternalRuntimeSnapshotState(nextState))
      rec.state = nextState
      rec.lastEventAt = entry.ts
      if (action === 'copilot.user_message') rec.turnStartedAt = metadataEntry.ts
      this.locallyProjectedExternalSessions.add(sessionId)
      if (!rec.firstUserMessage) rec.firstUserMessage = firstUserMessageFromState(nextState)
      this.summaryCache.delete(rec.logPath)
    })
    this.recordTails.set(sessionId, commit)
    try {
      await commit
    } finally {
      if (this.recordTails.get(sessionId) === commit) this.recordTails.delete(sessionId)
    }
  }

  list(): SessionRecord[] {
    return [...this.records.values()]
  }

  async listChildren(parentSessionId: string): Promise<SessionRecord[]> {
    const loaded = new Map<string, SessionRecord>()
    for (const record of this.records.values()) {
      if (record.parentSessionId === parentSessionId) loaded.set(record.sessionId, record)
    }
    if (!existsSync(this.sessionsDir)) return [...loaded.values()]
    const files = readdirSync(this.sessionsDir).filter((f) => f.endsWith('.jsonl'))
    for (const file of files) {
      const path = join(this.sessionsDir, file)
      if (loadedRecordForPath(this.records, path)) continue
      try {
        const header = await readSessionHeader(path)
        if (header.parentSessionId !== parentSessionId) continue
        const record = await this.loadFromFile(header.sessionId, path)
        loaded.set(record.sessionId, record)
      } catch {
        // Skip malformed or partially-written logs; session listing should be
        // best-effort and never block the dashboard from rendering.
      }
    }
    return [...loaded.values()]
  }

  /**
   * Attach or clear a memory policy on a live session record. Called by eval
   * runners after `ensure`/`create` when the session is a benchmark trial and
   * cross-task memory must be disabled. Pass `undefined` to clear.
   */
  setMemoryPolicy(sessionId: string, policy: SessionMemoryPolicy | undefined): void {
    const rec = this.records.get(sessionId)
    if (!rec) return
    if (policy === undefined) delete rec.memoryPolicy
    else rec.memoryPolicy = policy
  }

  /**
   * Persist a rename. Empty/whitespace label clears the override so summaries
   * fall back to firstUserMessage. Returns the applied value so the caller can
   * broadcast it without re-reading the record.
   */
  async rename(sessionId: string, label: string): Promise<string> {
    const rec = this.records.get(sessionId) ?? (await this.load(sessionId))
    const trimmed = label.trim()
    await appendMetadataEntry(rec.logPath, { label: trimmed })
    if (trimmed.length === 0) delete rec.label
    else rec.label = trimmed
    this.summaryCache.delete(rec.logPath)
    return trimmed
  }

  async renameWorkspace(workspaceId: string, workspaceName: string): Promise<number> {
    const trimmed = workspaceName.trim()
    if (workspaceId.trim().length === 0) throw new Error('workspaceId is required')
    if (trimmed.length === 0) throw new Error('workspace name is required')
    const summaries = await this.listSummaries()
    let count = 0
    for (const summary of summaries) {
      if (summary.workspaceId !== workspaceId) continue
      const rec = this.records.get(summary.sessionId) ?? (await this.load(summary.sessionId))
      await appendMetadataEntry(rec.logPath, { workspaceName: trimmed })
      ;(rec as { workspaceName?: string }).workspaceName = trimmed
      this.summaryCache.delete(rec.logPath)
      count += 1
    }
    return count
  }

  async delete(sessionId: string): Promise<void> {
    const paths = this.findLogsBySessionId(sessionId)
    const artifactSlugs = new Set(paths.map((path) => basename(path, '.jsonl')))
    const logArtifactRoot = join(this.sessionsDir, 'artifacts')
    if (existsSync(logArtifactRoot)) {
      for (const entry of readdirSync(logArtifactRoot)) {
        if (entry.endsWith(`_${sessionId}`)) artifactSlugs.add(entry)
      }
    }
    this.records.delete(sessionId)
    this.inFlight.delete(sessionId)
    this.runtimeRecoveries.delete(sessionId)
    this.locallyProjectedExternalSessions.delete(sessionId)
    this.recordTails.delete(sessionId)
    for (const path of paths) {
      this.summaryCache.delete(path)
      this.summaryLoads.delete(path)
      await rm(path, { force: true })
      await rm(snapshotSidecarPath(path), { force: true })
      await rm(summaryCachePath(path), { force: true })
      await rm(runtimeContextCachePath(path), { force: true })
    }

    for (const slug of artifactSlugs) {
      await rm(safeDirectChild(logArtifactRoot, slug), { recursive: true, force: true })
    }
    if (this.options.artifactRootDir) {
      for (const kind of SESSION_ARTIFACT_KINDS) {
        await rm(safeDirectChild(join(this.options.artifactRootDir, kind), sessionId), { recursive: true, force: true })
      }
    }
    await this.options.deleteRegisteredArtifacts?.(sessionId)
  }

  async purgeOrganizationSessions(params: {
    organizationId: string
    /**
     * Optional cutoff for retention jobs. The session is purged only when its
     * latest activity (`lastEventAt` or `createdAt`) is before this instant.
     * Omit for irreversible tenant-root deletion after the grace period.
     */
    before?: Date
  }): Promise<{ sessions: number; sessionIds: string[] }> {
    const organizationId = params.organizationId.trim()
    if (organizationId.length === 0) throw new Error('organizationId is required')
    const cutoffMs = params.before?.getTime()
    if (cutoffMs !== undefined && !Number.isFinite(cutoffMs)) throw new Error('invalid retention cutoff')
    const candidates = new Map<string, SessionRecord>()
    for (const record of this.records.values()) {
      if (record.organizationId === organizationId && sessionOlderThan(record, cutoffMs)) candidates.set(record.sessionId, record)
    }
    if (existsSync(this.sessionsDir)) {
      for (const file of readdirSync(this.sessionsDir)) {
        if (!file.endsWith('.jsonl')) continue
        const path = join(this.sessionsDir, file)
        if (loadedRecordForPath(this.records, path)) continue
        try {
          const header = await readSessionHeader(path)
          const record = await this.loadFromFile(header.sessionId, path, { recoverDangling: false })
          if (record.organizationId === organizationId && sessionOlderThan(record, cutoffMs)) candidates.set(record.sessionId, record)
        } catch {
          // Malformed logs are quarantined from tenant purge rather than being
          // guessed into another tenant's deletion set.
        }
      }
    }
    const sessionIds = [...candidates.keys()].sort()
    for (const sessionId of sessionIds) await this.delete(sessionId)
    return { sessions: sessionIds.length, sessionIds }
  }

  async updateRuntimeContextSnapshot(
    record: SessionRecord,
    contextSnapshot: ContextUsageSnapshot,
  ): Promise<void> {
    record.runtimeContextSnapshot = contextSnapshot
    await writeJsonFile(runtimeContextCachePath(record.logPath), {
      schemaVersion: 1,
      sessionId: record.sessionId,
      contextSnapshot,
    })
  }

  async listSummaries(): Promise<SessionSummary[]> {
    if (!existsSync(this.sessionsDir)) return []
    const files = readdirSync(this.sessionsDir).filter((f) =>
      f.endsWith('.jsonl'),
    )
    const out: SessionSummary[] = []
    for (const file of files) {
      const path = join(this.sessionsDir, file)
      try {
        const loaded = loadedRecordForPath(this.records, path)
        const summary = loaded
          ? summarizeRecord(loaded)
          : await this.cachedSummaryFor(path)
        out.push(summary)
      } catch {
        // Skip malformed files — a first-line-missing-header log means the
        // process crashed before it wrote anything usable. Don't fail the
        // whole listing because of one bad file.
      }
    }
    out.sort((a, b) =>
      (b.lastEventAt ?? b.createdAt).localeCompare(a.lastEventAt ?? a.createdAt),
    )
    return out
  }

  private async cachedSummaryFor(path: string): Promise<SessionSummary> {
    const stat = statSync(path)
    const cached = this.summaryCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.summary
    }
    const persisted = await readPersistedSummary(path)
    if (persisted && persisted.mtimeMs === stat.mtimeMs && persisted.size === stat.size) {
      this.summaryCache.set(path, persisted)
      return persisted.summary
    }
    const header = await readSessionHeader(path)
    if ((header.agentRuntime ?? 'kernel') !== 'kernel') {
      const snapshots = [...await optionalSnapshot(path)]
      const metadata = await readRecentSessionMetadata(path)
      const current = summarizeLog({
        header,
        events: [],
        snapshots,
        metadata,
        runtimeMetadata: [],
        warnings: [],
      })
      const summary: SessionSummary = {
        ...persisted?.summary,
        ...current,
        ...(persisted?.summary.agentRuntimeVersion
          ? { agentRuntimeVersion: persisted.summary.agentRuntimeVersion }
          : {}),
        eventCount: current.eventCount,
        ...(current.lastEventAt ? { lastEventAt: current.lastEventAt } : {}),
        ...(current.status ? { status: current.status } : {}),
        ...(current.currentCwd ? { currentCwd: current.currentCwd } : {}),
        ...(current.firstUserMessage ? { firstUserMessage: current.firstUserMessage } : {}),
      }
      const labelPatch = latestStringMetadataPatch(metadata, 'label')
      if (labelPatch.found) {
        if (labelPatch.value) summary.label = labelPatch.value
        else delete summary.label
      }
      const latest = statSync(path)
      if (latest.mtimeMs === stat.mtimeMs && latest.size === stat.size) {
        const cachedSummary = { mtimeMs: stat.mtimeMs, size: stat.size, summary }
        this.summaryCache.set(path, cachedSummary)
        await writeJsonFile(summaryCachePath(path), {
          schemaVersion: 2,
          ...cachedSummary,
          hasEvents: false,
          externalRuntimeAlreadyQuarantined: persisted?.externalRuntimeAlreadyQuarantined ?? false,
        })
      }
      return summary
    }
    const active = this.summaryLoads.get(path)
    if (active && active.mtimeMs === stat.mtimeMs && active.size === stat.size) {
      return active.promise
    }
    const load = readSessionState(path).then(async (parsed) => {
      const summary = summarizeLog(parsed)
      const latest = statSync(path)
      if (latest.mtimeMs === stat.mtimeMs && latest.size === stat.size) {
        const cachedSummary = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          summary,
        }
        this.summaryCache.set(path, cachedSummary)
        await writeJsonFile(summaryCachePath(path), {
          schemaVersion: 2,
          ...cachedSummary,
          hasEvents: parsed.events.length > 0,
          externalRuntimeAlreadyQuarantined: parsed.runtimeMetadata.some((entry) =>
            entry.action === 'runtime.quarantined_kernel_events'
          ),
        })
      }
      return summary
    })
    this.summaryLoads.set(path, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      promise: load,
    })
    try {
      return await load
    } finally {
      if (this.summaryLoads.get(path)?.promise === load) this.summaryLoads.delete(path)
    }
  }

  private pathFor(sessionId: string): string {
    const ts = new Date().toISOString().replace(/:/g, '-')
    return join(this.sessionsDir, `${ts}_${sessionId}.jsonl`)
  }

  private findLogByPrefix(sessionId: string): string | undefined {
    return this.findLogsBySessionId(sessionId)[0]
  }

  private findLogsBySessionId(sessionId: string): string[] {
    if (!existsSync(this.sessionsDir)) return []
    return readdirSync(this.sessionsDir)
      .filter((file) => file.endsWith(`_${sessionId}.jsonl`))
      .map((file) => join(this.sessionsDir, file))
  }

  private async loadFromFile(
    sessionId: string,
    path: string,
    options: { recoverDangling: boolean; runtimeConfig?: AgentConfig } = { recoverDangling: true },
  ): Promise<SessionRecord> {
    const header = await readSessionHeader(path)
    const persistedSummary = await readPersistedSummary(path)
    const runtimeContextSnapshot = await readPersistedRuntimeContext(path, sessionId)
    const fastExternalLoad = (header.agentRuntime ?? 'kernel') !== 'kernel'
    const externalRuntimeAlreadyQuarantined = fastExternalLoad
      ? persistedSummary?.externalRuntimeAlreadyQuarantined === true
        || await findLatestRuntimeMetadata(path, 'runtime.quarantined_kernel_events', { maxScanBytes: 64 * 1024 * 1024 }) !== undefined
      : false
    const latestExternalKernelEvent = fastExternalLoad && !externalRuntimeAlreadyQuarantined
      ? await findLatestEventEntry(path, { maxScanBytes: 64 * 1024 * 1024 })
      : undefined
    const recentExternalMetadata = fastExternalLoad
      ? await readRecentSessionMetadata(path)
      : []
    const externalSnapshots = fastExternalLoad ? await optionalSnapshot(path) : []
    const committedExternalProjection = externalSnapshots.at(-1)
    const latestCopilotUserMessage = fastExternalLoad && committedExternalProjection
      ? await findLatestRuntimeMetadata(path, 'copilot.user_message', {
          committedProjection: {
            cursor: committedExternalProjection.seq,
            ts: committedExternalProjection.ts,
          },
        })
      : undefined
    const parsed = fastExternalLoad
      ? {
          header,
          events: latestExternalKernelEvent ? [latestExternalKernelEvent] : [],
          snapshots: [...externalSnapshots],
          metadata: recentExternalMetadata,
          runtimeMetadata: externalRuntimeAlreadyQuarantined
            ? [{
                kind: 'runtime_metadata' as const,
                ts: header.ts,
                sessionId,
                action: 'runtime.quarantined_kernel_events',
                payload: {},
              }]
            : [],
          warnings: [],
        }
      : await readSessionState(path)
    const agentRuntime = parsed.header.agentRuntime ?? 'kernel'
    const events = parsed.events.map((e) => e.event)
    const lastSnapshot = parsed.snapshots.at(-1)
    let finalState = agentRuntime === 'kernel'
      ? fold(parsed.header.initialState, events, parsed.header.config)
      : lastSnapshot?.state ?? parsed.header.initialState
    let cursor = finalState.cursor

    const parsedExternalRuntimeAlreadyQuarantined = parsed.runtimeMetadata.some((entry) =>
      entry.action === 'runtime.quarantined_kernel_events',
    )
    if (
      options.recoverDangling
      && agentRuntime !== 'kernel'
      && parsed.events.length > 0
      && !parsedExternalRuntimeAlreadyQuarantined
    ) {
      const foreignEventCursor = parsed.events.at(-1)?.seq ?? finalState.cursor
      finalState = quarantinedExternalRuntimeState(finalState, foreignEventCursor)
      cursor = finalState.cursor
      await appendRuntimeMetadataEntry(path, {
        sessionId,
        action: 'runtime.quarantined_kernel_events',
        payload: { eventCount: parsed.events.length },
      })
      const quarantineSnapshot = await appendSnapshotEntry(path, cursor, finalState)
      parsed.snapshots.push(quarantineSnapshot)
    } else if (options.recoverDangling && needsExternalRuntimeRecovery(agentRuntime, finalState)) {
      const interruptedCalls = finalState.pendingCalls
      finalState = interruptedExternalRuntimeState(agentRuntime, finalState)!
      cursor = finalState.cursor
      await appendRuntimeMetadataEntry(path, {
        sessionId,
        action: 'copilot.recovered_interrupted_turn',
        payload: { pendingCallCount: interruptedCalls.length },
      })
      const recoverySnapshot = await appendSnapshotEntry(path, cursor, finalState)
      parsed.snapshots.push(recoverySnapshot)
    }

    // Crash recovery: a session that was mid-tool-call when the host died
    // has status='awaiting_approval' or 'executing_tools' with non-empty
    // pendingCalls. The promise that would have resolved is gone, so the
    // session hangs. Synthesize a failed tool_result for each pending call
    // and append it to the log so replay stays exact.
    let recoveredPending = false
    if (
      options.recoverDangling &&
      agentRuntime === 'kernel' &&
      (finalState.status === 'awaiting_approval' ||
        finalState.status === 'executing_tools') &&
      finalState.pendingCalls.length > 0
    ) {
      recoveredPending = true
      for (const pending of finalState.pendingCalls) {
        const recoveryEvent: AgentEvent = {
          kind: 'tool_result',
          callId: pending.callId,
          ok: false,
          content: 'host restarted while call was pending',
        }
        // `awaiting_approval` calls never got a `dispatched` status, so the
        // reducer would refuse a `tool_result` for them. Approve first to
        // move the call into `dispatched`, then feed the failure — the
        // reducer will accept it and settle the pending list.
        if (pending.status === 'awaiting_approval') {
          const approveEvent: AgentEvent = {
            kind: 'user_approve',
            callId: pending.callId,
          }
          const { next, effects } = step(
            finalState,
            approveEvent,
            parsed.header.config,
          )
          finalState = next
          cursor = next.cursor
          const entry = await appendEventEntry({
            path,
            seq: cursor,
            event: approveEvent,
            effects,
          })
          parsed.events.push(entry)
        }
        const { next, effects } = step(finalState, recoveryEvent, parsed.header.config)
        finalState = next
        cursor = next.cursor
        const entry = await appendEventEntry({
          path,
          seq: cursor,
          event: recoveryEvent,
          effects,
        })
        parsed.events.push(entry)
      }
    }

    // Mid-stream recovery: status='thinking' with no pendingCalls means the
    // last effect was `call_llm` and the reply never came back before the
    // host died. Without a synthetic response the session would sit in
    // `thinking` forever — no client notification, no way to send a new
    // user message (reducer only accepts `user_message` from idle/done/error).
    // Synthesize a minimal assistant message so the reducer transitions to
    // `done` and dashboards see the closure via the normal event broadcast.
    //
    // Guard: skip if we just recovered pending tool calls above. In that
    // case `thinking` is a transient state produced by our synthetic events
    // asking the LLM to react to the failures — that's a legitimate next
    // turn, not a stuck stream.
    if (
      options.recoverDangling &&
      agentRuntime === 'kernel' &&
      !recoveredPending &&
      finalState.status === 'thinking' &&
      finalState.pendingCalls.length === 0
    ) {
      const recoveryEvent: AgentEvent = {
        kind: 'llm_response',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '[interrupted]' }],
        },
      }
      const { next, effects } = step(finalState, recoveryEvent, parsed.header.config)
      finalState = next
      cursor = next.cursor
      const entry = await appendEventEntry({
        path,
        seq: cursor,
        event: recoveryEvent,
        effects,
      })
      parsed.events.push(entry)
    }

    const latestWorkspaceId =
      latestStringFromMetadata(parsed.metadata, 'workspaceId') ??
      persistedSummary?.summary.workspaceId ??
      parsed.header.workspaceId
    const latestWorkspaceName =
      latestStringFromMetadata(parsed.metadata, 'workspaceName') ??
      persistedSummary?.summary.workspaceName ??
      parsed.header.workspaceName
    const latestOrganizationId =
      latestStringFromMetadata(parsed.metadata, 'organizationId') ??
      parsed.header.organizationId
    const latestPrincipal =
      latestStringFromMetadata(parsed.metadata, 'principal') ??
      parsed.header.principal
    const latestOrganizationRole =
      latestOrganizationRoleFromMetadata(parsed.metadata) ??
      parsed.header.organizationRole
    const labelPatch = latestStringMetadataPatch(parsed.metadata, 'label')
    const label = labelPatch.found
      ? labelPatch.value
      : persistedSummary?.summary.label
    const firstUserMessage = agentRuntime === 'kernel'
      ? firstUserMessageFromEvents(parsed.events)
      : firstUserMessageFromState(finalState)
    const turnStartedAt = agentRuntime === 'kernel'
      ? latestKernelTurnStartedAt(parsed.events)
      : validTimestamp(latestCopilotUserMessage?.ts)
    const selectedModel = latestStringFromMetadata(parsed.metadata, 'selectedModel') ??
      persistedSummary?.summary.preferences?.selectedModel
    const toolCardMode = latestToolCardModeFromMetadata(parsed.metadata) ??
      persistedSummary?.summary.preferences?.toolCardMode
    const preferences: SessionPreferences = {
      ...(selectedModel
        ? { selectedModel }
        : {}),
      ...(toolCardMode ? { toolCardMode } : {}),
    }

    const record: SessionRecord = {
      sessionId,
      agentRuntime,
      ...(parsed.header.agentRuntimeVersion ? { agentRuntimeVersion: parsed.header.agentRuntimeVersion } : {}),
      ...(parsed.header.externalSessionId ? { externalSessionId: parsed.header.externalSessionId } : {}),
      logPath: path,
      createdAt: parsed.header.ts,
      config: options.runtimeConfig ?? parsed.header.config,
      toolLock: toolLockFor(parsed.header.config),
      preferences,
      ...(runtimeContextSnapshot ? { runtimeContextSnapshot } : {}),
      ...(persistedSummary?.summary.lastEventAt || parsed.events.length > 0
        ? { lastEventAt: persistedSummary?.summary.lastEventAt ?? parsed.events[parsed.events.length - 1]!.ts }
        : {}),
      state: finalState,
      ...(turnStartedAt ? { turnStartedAt } : {}),
      ...(firstUserMessage ? { firstUserMessage } : {}),
      ...(parsed.header.parentSessionId
        ? { parentSessionId: parsed.header.parentSessionId }
        : {}),
      ...(parsed.header.parentCursor !== undefined
        ? { parentCursor: parsed.header.parentCursor }
        : {}),
      ...(parsed.header.parentCallId !== undefined
        ? { parentCallId: parsed.header.parentCallId }
        : {}),
      ...(parsed.header.agentType !== undefined
        ? { agentType: parsed.header.agentType }
        : {}),
      ...(parsed.header.subAgentStartedAt !== undefined
        ? { subAgentStartedAt: parsed.header.subAgentStartedAt }
        : {}),
      ...(latestWorkspaceId !== undefined
        ? { workspaceId: latestWorkspaceId }
        : {}),
      ...(latestWorkspaceName !== undefined
        ? { workspaceName: latestWorkspaceName }
        : {}),
      ...(latestOrganizationId !== undefined
        ? { organizationId: latestOrganizationId }
        : {}),
      ...(latestPrincipal !== undefined
        ? { principal: latestPrincipal }
        : {}),
      ...(latestOrganizationRole !== undefined
        ? { organizationRole: latestOrganizationRole }
        : {}),
      ...(label
        ? { label }
        : {}),
    }
    this.records.set(sessionId, record)
    this.summaryCache.delete(path)
    return record
  }

  private async appendInterruptedLlmRecovery(record: SessionRecord): Promise<{
    event: AgentEvent
    effects: readonly Effect[]
  } | null> {
    if (record.state.status !== 'thinking' || record.state.pendingCalls.length > 0) {
      return null
    }
    const event: AgentEvent = interruptedLlmRecoveryEvent()
    const { next, effects } = step(record.state, event, record.config)
    const entry = await appendEventEntry({
      path: record.logPath,
      seq: next.cursor,
      event,
      effects,
    })
    record.state = next
    record.lastEventAt = entry.ts
    this.summaryCache.delete(record.logPath)
    return { event, effects }
  }
}

function safeDirectChild(parent: string, child: string): string {
  const root = resolve(parent)
  const target = resolve(root, child)
  if (dirname(target) !== root) throw new Error('refusing to delete an unsafe Session artifact path')
  return target
}

function interruptedLlmRecoveryEvent(): AgentEvent {
  return {
    kind: 'llm_response',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '[interrupted]' }],
    },
  }
}

type CachedSessionSummary = {
  mtimeMs: number
  size: number
  summary: SessionSummary
  hasEvents?: boolean
  externalRuntimeAlreadyQuarantined?: boolean
}

type PersistedSessionSummary = CachedSessionSummary & {
  schemaVersion: 2
  hasEvents: boolean
  externalRuntimeAlreadyQuarantined: boolean
}

function summaryCachePath(logPath: string): string {
  return `${logPath}.summary.json`
}

function runtimeContextCachePath(logPath: string): string {
  return `${logPath}.context.json`
}

async function readPersistedRuntimeContext(
  logPath: string,
  sessionId: string,
): Promise<ContextUsageSnapshot | undefined> {
  try {
    const parsed = JSON.parse(await readFile(runtimeContextCachePath(logPath), 'utf8')) as {
      schemaVersion?: unknown
      sessionId?: unknown
      contextSnapshot?: unknown
    }
    if (
      parsed.schemaVersion !== 1
      || parsed.sessionId !== sessionId
      || !isContextUsageSnapshot(parsed.contextSnapshot)
    ) return undefined
    return parsed.contextSnapshot
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

function isContextUsageSnapshot(value: unknown): value is ContextUsageSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<ContextUsageSnapshot>
  return typeof snapshot.model?.ref === 'string'
    && (snapshot.contextWindow?.tokens === null || typeof snapshot.contextWindow?.tokens === 'number')
    && typeof snapshot.contextWindow?.source === 'string'
    && typeof snapshot.usage?.inputTokens === 'number'
    && typeof snapshot.usage?.totalTokens === 'number'
    && typeof snapshot.updatedAt === 'number'
}

async function readPersistedSummary(logPath: string): Promise<CachedSessionSummary | undefined> {
  try {
    const parsed = JSON.parse(await readFile(summaryCachePath(logPath), 'utf8')) as Partial<PersistedSessionSummary>
    if (
      parsed.schemaVersion !== 2
      || typeof parsed.mtimeMs !== 'number'
      || typeof parsed.size !== 'number'
      || typeof parsed.hasEvents !== 'boolean'
      || typeof parsed.externalRuntimeAlreadyQuarantined !== 'boolean'
      || !parsed.summary
      || typeof parsed.summary.sessionId !== 'string'
    ) return undefined
    return {
      mtimeMs: parsed.mtimeMs,
      size: parsed.size,
      summary: parsed.summary,
      hasEvents: parsed.hasEvents,
      externalRuntimeAlreadyQuarantined: parsed.externalRuntimeAlreadyQuarantined,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

function loadedRecordForPath(
  records: ReadonlyMap<string, SessionRecord>,
  path: string,
): SessionRecord | undefined {
  for (const record of records.values()) {
    if (record.logPath === path) return record
  }
  return undefined
}

function summarizeRecord(record: SessionRecord): SessionSummary {
  return {
    sessionId: record.sessionId,
    agentRuntime: record.agentRuntime,
    ...(record.agentRuntimeVersion ? { agentRuntimeVersion: record.agentRuntimeVersion } : {}),
    createdAt: record.createdAt,
    eventCount: record.state.cursor,
    ...(record.lastEventAt ? { lastEventAt: record.lastEventAt } : {}),
    ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
    ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
    ...(record.workspaceName !== undefined ? { workspaceName: record.workspaceName } : {}),
    status: record.state.status,
    ...(record.state.cwd ? { currentCwd: record.state.cwd } : {}),
    ...(record.firstUserMessage ? { firstUserMessage: record.firstUserMessage.slice(0, 120) } : {}),
    ...(record.label ? { label: record.label } : {}),
    ...(Object.keys(record.preferences).length > 0 ? { preferences: record.preferences } : {}),
  }
}

function sessionOlderThan(record: SessionRecord, cutoffMs: number | undefined): boolean {
  if (cutoffMs === undefined) return true
  const activity = Date.parse(record.lastEventAt ?? record.createdAt)
  return Number.isFinite(activity) && activity < cutoffMs
}

function needsExternalRuntimeRecovery(
  agentRuntime: AgentRuntimeId,
  state: AgentState,
): boolean {
  return agentRuntime !== 'kernel' && (
    state.status === 'thinking'
    || state.status === 'awaiting_approval'
    || state.status === 'executing_tools'
  )
}

function interruptedExternalRuntimeState(
  agentRuntime: AgentRuntimeId,
  state: AgentState,
): AgentState | undefined {
  if (!needsExternalRuntimeRecovery(agentRuntime, state)) return undefined
  return {
    ...state,
    cursor: state.cursor + 1,
    status: 'error',
    pendingCalls: [],
    messages: [
      ...state.messages,
      ...state.pendingCalls.map((call) => ({
        role: 'tool' as const,
        content: [{
          type: 'tool_result' as const,
          callId: call.callId,
          ok: false,
          content: 'host restarted while call was pending',
        }],
      })),
    ],
    error: 'Copilot turn was interrupted by a host restart',
  }
}

function quarantinedExternalRuntimeState(state: AgentState, minimumCursor = state.cursor): AgentState {
  const message = 'Non-Kernel Session contained Kernel events and was quarantined'
  return {
    ...state,
    cursor: Math.max(state.cursor + 1, minimumCursor),
    status: 'error',
    pendingCalls: [],
    messages: [...state.messages, {
      role: 'assistant',
      content: [{ type: 'text', text: message }],
    }],
    error: message,
  }
}

function firstUserMessageFromEvents(
  events: readonly { event: AgentEvent }[],
): string | undefined {
  for (const entry of events) {
    if (entry.event.kind !== 'user_message') continue
    if (entry.event.text?.trim()) return entry.event.text
  }
  return undefined
}

function latestKernelTurnStartedAt(events: readonly EventEntry[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index]
    if (entry?.event.kind !== 'user_message') continue
    return validTimestamp(entry.timing?.turnStartedAt) ?? validTimestamp(entry.ts)
  }
  return undefined
}

function validTimestamp(value: string | undefined): string | undefined {
  return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined
}

function summarizeLog(
  parsed: Awaited<ReturnType<typeof readSessionLog>>,
): SessionSummary {
  const header = parsed.header
  const agentRuntime = header.agentRuntime ?? 'kernel'
  const events = parsed.events
  const lastEvent = events.length > 0 ? events[events.length - 1]! : undefined
  const lastSnapshot =
    parsed.snapshots.length > 0
      ? parsed.snapshots[parsed.snapshots.length - 1]!
      : undefined
  const firstUserText = agentRuntime === 'kernel'
    ? firstUserMessageFromEvents(events)
    : firstUserMessageFromState(lastSnapshot?.state ?? header.initialState)
  const label = latestStringFromMetadata(parsed.metadata, 'label')
  const selectedModel = latestStringFromMetadata(parsed.metadata, 'selectedModel')
  const toolCardMode = latestToolCardModeFromMetadata(parsed.metadata)
  const workspaceId =
    latestStringFromMetadata(parsed.metadata, 'workspaceId') ?? header.workspaceId
  const workspaceName =
    latestStringFromMetadata(parsed.metadata, 'workspaceName') ?? header.workspaceName
  // executorId is deliberately not inferred from the log — the JSONL doesn't
  // record which executor produced each tool_result, so any inference here
  // would be a guess. Host can layer it on later by tracking attach history.
  const status =
    lastSnapshot?.state.status ?? statusFromEffects(events)
  const foldedState = lastSnapshot?.state ?? fold(
    header.initialState,
    events.map((e) => e.event),
    header.config,
  )
  return {
    sessionId: header.sessionId,
    agentRuntime,
    createdAt: header.ts,
    eventCount: agentRuntime === 'kernel' ? events.length : (lastSnapshot?.seq ?? 0),
    ...((lastSnapshot?.ts ?? lastEvent?.ts) ? { lastEventAt: lastSnapshot?.ts ?? lastEvent?.ts } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(workspaceId !== undefined
      ? { workspaceId }
      : {}),
    ...(workspaceName !== undefined
      ? { workspaceName }
      : {}),
    ...(status ? { status } : {}),
    ...(foldedState.cwd
      ? { currentCwd: foldedState.cwd }
      : {}),
    ...(firstUserText
      ? { firstUserMessage: firstUserText.slice(0, 120) }
      : {}),
    ...(label ? { label } : {}),
    ...(selectedModel || toolCardMode
      ? { preferences: { ...(selectedModel ? { selectedModel } : {}), ...(toolCardMode ? { toolCardMode } : {}) } }
      : {}),
  }

}

function firstUserMessageFromState(state: AgentState): string | undefined {
  for (const message of state.messages) {
    if (!isRealUserMessage(message)) continue
    const text = message.content.find((content) => content.type === 'text')
    if (text?.type === 'text' && text.text.trim()) return text.text
  }
  return undefined
}

/** Walk metadata entries in reverse to find the most recent string value. */
function latestStringMetadataPatch(
  metadata: readonly Record<string, string | undefined>[],
  key: 'label' | 'workspaceId' | 'workspaceName' | 'selectedModel' | 'organizationId' | 'principal',
): { found: false } | { found: true; value: string | undefined } {
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i]!
    const value = entry[key]
    if (value === undefined) continue
    const trimmed = value.trim()
    return { found: true, value: trimmed.length === 0 ? undefined : trimmed }
  }
  return { found: false }
}

function latestStringFromMetadata(
  metadata: readonly Record<string, string | undefined>[],
  key: 'label' | 'workspaceId' | 'workspaceName' | 'selectedModel' | 'organizationId' | 'principal',
): string | undefined {
  const patch = latestStringMetadataPatch(metadata, key)
  return patch.found ? patch.value : undefined
}

function latestOrganizationRoleFromMetadata(
  metadata: readonly Record<string, string | undefined>[],
): 'owner' | 'admin' | 'member' | 'viewer' | undefined {
  for (let i = metadata.length - 1; i >= 0; i--) {
    const value = metadata[i]!.organizationRole
    if (value === 'owner' || value === 'admin' || value === 'member' || value === 'viewer') return value
  }
  return undefined
}

function latestToolCardModeFromMetadata(
  metadata: readonly Record<string, string | undefined>[],
): 'dots' | 'standard' | undefined {
  for (let i = metadata.length - 1; i >= 0; i--) {
    const value = metadata[i]!.toolCardMode
    if (value === 'dots' || value === 'standard') return value
  }
  return undefined
}

function normalizedPreferences(preferences: SessionPreferences | undefined): SessionPreferences {
  const selectedModel = normalizePreferenceString(preferences?.selectedModel)
  return {
    ...(selectedModel ? { selectedModel } : {}),
    ...(preferences?.toolCardMode ? { toolCardMode: preferences.toolCardMode } : {}),
  }
}

function normalizePreferenceString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

// Older logs (pre-snapshot-writer) have no snapshot lines. Recover an
// approximate status from the effects the reducer emitted on each event —
// finish → done, emit_error → error, request_approval → awaiting_approval.
function statusFromEffects(
  events: Awaited<ReturnType<typeof readSessionLog>>['events'],
): SessionSummary['status'] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const effects = events[i]!.effects
    for (const eff of effects) {
      if (eff.kind === 'finish') return 'done'
      if (eff.kind === 'emit_error') return 'error'
      if (eff.kind === 'request_approval') return 'awaiting_approval'
    }
  }
  return undefined
}
