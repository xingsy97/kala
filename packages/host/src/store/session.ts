/**
 * Session store. In-memory map of live sessions + append-only JSONL log per
 * session on disk. The log is the source of truth; the in-memory record is
 * a cache for hot access.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'
import type { LLMTrace } from '@agent-kernel/shared'
import type { EvalMemoryPolicy } from '@agent-kernel/shared/enhancement'
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

export type SessionRecord = {
  readonly sessionId: string
  readonly logPath: string
  readonly config: AgentConfig
  readonly parentSessionId?: string
  readonly parentCursor?: number
  readonly workspaceId?: string
  readonly workspaceName?: string
  state: AgentState
  /**
   * Operator-set display label from the most recent `client:rename_session`.
   * Loaded from the last MetadataEntry in the JSONL and updated in place
   * whenever the host writes a new metadata line.
   */
  label?: string
  /**
   * Host-side memory policy for this session. When `mode: 'disabled'`, the
   * loop rejects `memory` tool calls to workspace/global scope so a benchmark
   * session cannot inadvertently pull cross-task state from disk. Not part of
   * kernel state — the reducer never sees it and it is never persisted into
   * the JSONL ledger. Callers (eval runners, tests, CLI) attach it via
   * `CreateSessionParams.memoryPolicy`.
   */
  memoryPolicy?: EvalMemoryPolicy
}

export type CreateSessionParams = {
  systemPrompt?: string
  config: AgentConfig
  parentSessionId?: string
  parentCursor?: number
  initialState?: AgentState
  sessionId?: string
  workspaceId?: string
  workspaceName?: string
  initialCwd?: string
  initialApprovalMode?: import('@agent-kernel/kernel').ApprovalMode
  memoryPolicy?: EvalMemoryPolicy
}

export class SessionStore {
  private readonly records = new Map<string, SessionRecord>()
  /**
   * De-duplicates concurrent `ensure` / `load` requests for the same
   * sessionId. Two dashboard + executor sockets arriving for a fresh
   * session in the same tick previously raced through
   * `get → load(fail) → create` and produced two log files on disk. The
   * in-flight map guarantees only one `create()` per sessionId.
   */
  private readonly inFlight = new Map<string, Promise<SessionRecord>>()

  constructor(private readonly sessionsDir: string) {
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
    await writeHeader({
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
      config: params.config,
      state: stateWithApproval,
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
      ...(params.memoryPolicy !== undefined
        ? { memoryPolicy: params.memoryPolicy }
        : {}),
    }
    this.records.set(sessionId, record)
    return record
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId)
  }

  async load(sessionId: string): Promise<SessionRecord> {
    const cached = this.records.get(sessionId)
    if (cached) return cached
    const inflight = this.inFlight.get(sessionId)
    if (inflight) return inflight
    const promise = this.loadInner(sessionId).finally(() => {
      this.inFlight.delete(sessionId)
    })
    this.inFlight.set(sessionId, promise)
    return promise
  }

  private async loadInner(sessionId: string): Promise<SessionRecord> {
    const path = this.pathFor(sessionId)
    if (!existsSync(path)) {
      const found = this.findLogByPrefix(sessionId)
      if (!found) throw new Error(`Unknown session: ${sessionId}`)
      return this.loadFromFile(sessionId, found)
    }
    return this.loadFromFile(sessionId, path)
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
  }): Promise<{ record: SessionRecord; created: boolean }> {
    const cached = this.records.get(params.sessionId)
    if (cached) {
      await this.applyMissingCreateMetadata(cached, params)
      return { record: cached, created: false }
    }
    const inflight = this.inFlight.get(params.sessionId)
    if (inflight) {
      const record = await inflight
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
    markCreated: () => void,
  ): Promise<SessionRecord> {
    try {
      const record = await this.loadInner(sessionId)
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
    }
    if (record.state.cwd === undefined && params.initialCwd !== undefined) {
      const event: AgentEvent = { kind: 'cwd_changed', cwd: params.initialCwd }
      const { next, effects } = step(record.state, event, record.config)
      await appendEventEntry({
        path: record.logPath,
        seq: next.cursor,
        event,
        effects,
      })
      record.state = next
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
  ): Promise<void> {
    const rec = this.records.get(sessionId)
    if (!rec) throw new Error(`Cannot record on unknown session: ${sessionId}`)
    await appendEventEntry({
      path: rec.logPath,
      seq: nextState.cursor,
      event,
      effects,
      ...(usageDelta ? { usage: usageDelta } : {}),
      ...(llmTrace ? { llmTrace } : {}),
      ...(model ? { model } : {}),
    })
    rec.state = nextState
  }

  list(): SessionRecord[] {
    return [...this.records.values()]
  }

  /**
   * Attach or clear a memory policy on a live session record. Called by eval
   * runners after `ensure`/`create` when the session is a benchmark trial and
   * cross-task memory must be disabled. Pass `undefined` to clear.
   */
  setMemoryPolicy(sessionId: string, policy: EvalMemoryPolicy | undefined): void {
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
      count += 1
    }
    return count
  }

  async delete(sessionId: string): Promise<void> {
    const cached = this.records.get(sessionId)
    const path = cached?.logPath ?? this.findLogByPrefix(sessionId)
    this.records.delete(sessionId)
    this.inFlight.delete(sessionId)
    if (path && existsSync(path)) await unlink(path)
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
        const parsed = await readSessionLog(path)
        const summary = summarizeLog(parsed)
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

  private pathFor(sessionId: string): string {
    const ts = new Date().toISOString().replace(/:/g, '-')
    return join(this.sessionsDir, `${ts}_${sessionId}.jsonl`)
  }

  private findLogByPrefix(sessionId: string): string | undefined {
    if (!existsSync(this.sessionsDir)) return undefined
    const files = readdirSync(this.sessionsDir)
    const match = files.find((f) => f.endsWith(`_${sessionId}.jsonl`))
    return match ? join(this.sessionsDir, match) : undefined
  }

  private async loadFromFile(
    sessionId: string,
    path: string,
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
          await appendEventEntry({
            path,
            seq: cursor,
            event: approveEvent,
            effects,
          })
        }
        const { next, effects } = step(finalState, recoveryEvent, parsed.header.config)
        finalState = next
        cursor = next.cursor
        await appendEventEntry({
          path,
          seq: cursor,
          event: recoveryEvent,
          effects,
        })
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
      await appendEventEntry({
        path,
        seq: cursor,
        event: recoveryEvent,
        effects,
      })
    }

    const latestWorkspaceId =
      latestStringFromMetadata(parsed.metadata, 'workspaceId') ??
      parsed.header.workspaceId
    const latestWorkspaceName =
      latestStringFromMetadata(parsed.metadata, 'workspaceName') ??
      parsed.header.workspaceName
    const label = latestStringFromMetadata(parsed.metadata, 'label')

    const record: SessionRecord = {
      sessionId,
      logPath: path,
      config: parsed.header.config,
      state: finalState,
      ...(parsed.header.parentSessionId
        ? { parentSessionId: parsed.header.parentSessionId }
        : {}),
      ...(parsed.header.parentCursor !== undefined
        ? { parentCursor: parsed.header.parentCursor }
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
    return record
  }
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
  const firstUserEvent = events.find((e) => e.event.kind === 'user_message')
  const firstUserText =
    firstUserEvent && firstUserEvent.event.kind === 'user_message'
      ? firstUserEvent.event.text
      : undefined
  const label = latestStringFromMetadata(parsed.metadata, 'label')
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
  }
}

/** Walk metadata entries in reverse to find the most recent string value. */
function latestStringFromMetadata(
  metadata: readonly Record<string, string | undefined>[],
  key: 'label' | 'workspaceId' | 'workspaceName',
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
