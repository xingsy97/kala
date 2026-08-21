/**
 * Session store. In-memory map of live sessions + append-only JSONL log per
 * session on disk. The log is the source of truth; the in-memory record is
 * a cache for hot access.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'
import type { LLMTrace, SessionMemoryPolicy, SessionPreferences } from '@agent-kernel/shared'
import { createInitialState, fold } from '@agent-kernel/kernel'
import type { SessionSummary } from '@agent-kernel/shared'
import { ulid } from 'ulid'

import {
  appendEventEntry,
  appendMetadataEntry,
  readSessionLog,
  writeHeader,
} from './log.js'
import { step } from '@agent-kernel/kernel'
import { toolLockFor } from '../tool-version.js'

export type SessionRecord = {
  readonly sessionId: string
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
  lastEventAt?: string
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

export type CreateSessionParams = {
  systemPrompt?: string
  config: AgentConfig
  parentSessionId?: string
  parentCursor?: number
  parentCallId?: string
  agentType?: string
  subAgentStartedAt?: string
  initialState?: AgentState
  sessionId?: string
  workspaceId?: string
  workspaceName?: string
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
  /**
   * De-duplicates concurrent `ensure` / `load` requests for the same
   * sessionId. Two dashboard + executor sockets arriving for a fresh
   * session in the same tick previously raced through
   * `get → load(fail) → create` and produced two log files on disk. The
   * in-flight map guarantees only one `create()` per sessionId.
   */
  private readonly inFlight = new Map<string, Promise<SessionRecord>>()
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
      ...(params.initialCwd !== undefined
        ? { initialCwd: params.initialCwd }
        : {}),
    })
    const record: SessionRecord = {
      sessionId,
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

  private async loadInner(sessionId: string, options: { recoverDangling: boolean; runtimeConfig?: AgentConfig }): Promise<SessionRecord> {
    const path = this.pathFor(sessionId)
    if (!existsSync(path)) {
      const found = this.findLogByPrefix(sessionId)
      if (!found) throw new Error(`Unknown session: ${sessionId}`)
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
    defaultConfig: AgentConfig
    workspaceId?: string
    workspaceName?: string
    initialCwd?: string
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
      params.initialCwd,
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
    initialCwd: string | undefined,
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
        ...(initialCwd !== undefined ? { initialCwd } : {}),
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
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(initialCwd !== undefined ? { initialCwd } : {}),
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
    if (metadataChanged) {
      await appendMetadataEntry(record.logPath, {
        ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
        ...(record.workspaceName !== undefined ? { workspaceName: record.workspaceName } : {}),
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
        const parsed = await readSessionLog(path)
        if (parsed.header.parentSessionId !== parentSessionId) continue
        const record = await this.loadFromFile(parsed.header.sessionId, path)
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
    this.recordTails.delete(sessionId)
    for (const path of paths) {
      this.summaryCache.delete(path)
      await rm(path, { force: true })
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
    const parsed = await readSessionLog(path)
    const summary = summarizeLog(parsed)
    this.summaryCache.set(path, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      summary,
    })
    return summary
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
    const parsed = await readSessionLog(path)
    const events = parsed.events.map((e) => e.event)
    let finalState = fold(parsed.header.initialState, events, parsed.header.config)
    let cursor = finalState.cursor

    // Crash recovery: a session that was mid-tool-call when the host died
    // has status='awaiting_approval' or 'executing_tools' with non-empty
    // pendingCalls. The promise that would have resolved is gone, so the
    // session hangs. Synthesize a failed tool_result for each pending call
    // and append it to the log so replay stays exact.
    let recoveredPending = false
    if (
      options.recoverDangling &&
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
      parsed.header.workspaceId
    const latestWorkspaceName =
      latestStringFromMetadata(parsed.metadata, 'workspaceName') ??
      parsed.header.workspaceName
    const label = latestStringFromMetadata(parsed.metadata, 'label')
    const firstUserMessage = firstUserMessageFromEvents(parsed.events)
    const selectedModel = latestStringFromMetadata(parsed.metadata, 'selectedModel')
    const toolCardMode = latestToolCardModeFromMetadata(parsed.metadata)
    const preferences: SessionPreferences = {
      ...(selectedModel
        ? { selectedModel }
        : {}),
      ...(toolCardMode ? { toolCardMode } : {}),
    }

    const record: SessionRecord = {
      sessionId,
      logPath: path,
      createdAt: parsed.header.ts,
      config: options.runtimeConfig ?? parsed.header.config,
      toolLock: toolLockFor(parsed.header.config),
      preferences,
      ...(parsed.events.length > 0
        ? { lastEventAt: parsed.events[parsed.events.length - 1]!.ts }
        : {}),
      state: finalState,
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

function firstUserMessageFromEvents(
  events: readonly { event: AgentEvent }[],
): string | undefined {
  for (const entry of events) {
    if (entry.event.kind !== 'user_message') continue
    if (entry.event.text?.trim()) return entry.event.text
  }
  return undefined
}

function summarizeLog(
  parsed: Awaited<ReturnType<typeof readSessionLog>>,
): SessionSummary {
  const header = parsed.header
  const events = parsed.events
  const lastEvent = events.length > 0 ? events[events.length - 1]! : undefined
  const lastSnapshot =
    parsed.snapshots.length > 0
      ? parsed.snapshots[parsed.snapshots.length - 1]!
      : undefined
  const firstUserText = firstUserMessageFromEvents(events)
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
    createdAt: header.ts,
    eventCount: events.length,
    ...(lastEvent ? { lastEventAt: lastEvent.ts } : {}),
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

/** Walk metadata entries in reverse to find the most recent string value. */
function latestStringFromMetadata(
  metadata: readonly Record<string, string | undefined>[],
  key: 'label' | 'workspaceId' | 'workspaceName' | 'selectedModel',
): string | undefined {
  for (let i = metadata.length - 1; i >= 0; i--) {
    const entry = metadata[i]!
    const value = entry[key]
    if (value === undefined) continue
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
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
