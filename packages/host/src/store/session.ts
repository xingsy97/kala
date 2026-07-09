/**
 * Session store. In-memory map of live sessions + append-only JSONL log per
 * session on disk. The log is the source of truth; the in-memory record is
 * a cache for hot access.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  UsageTotal,
} from '@agent-kernel/kernel'
import { createInitialState, fold } from '@agent-kernel/kernel'
import { ulid } from 'ulid'

import {
  appendEventEntry,
  readSessionLog,
  writeHeader,
} from './log.js'

export type SessionRecord = {
  readonly sessionId: string
  readonly logPath: string
  readonly config: AgentConfig
  readonly parentSessionId?: string
  readonly parentCursor?: number
  state: AgentState
}

export type CreateSessionParams = {
  systemPrompt?: string
  config: AgentConfig
  parentSessionId?: string
  parentCursor?: number
  initialState?: AgentState
  sessionId?: string
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

  async create(params: CreateSessionParams): Promise<SessionRecord> {
    const sessionId = params.sessionId ?? ulid()
    const initialState =
      params.initialState ??
      createInitialState({
        sessionId,
        systemPrompt: params.systemPrompt ?? params.config.systemPrompt,
      })
    const logPath = this.pathFor(sessionId)
    await writeHeader({
      path: logPath,
      sessionId,
      config: params.config,
      initialState,
      ...(params.parentSessionId
        ? { parentSessionId: params.parentSessionId }
        : {}),
      ...(params.parentCursor !== undefined
        ? { parentCursor: params.parentCursor }
        : {}),
    })
    const record: SessionRecord = {
      sessionId,
      logPath,
      config: params.config,
      state: initialState,
      ...(params.parentSessionId
        ? { parentSessionId: params.parentSessionId }
        : {}),
      ...(params.parentCursor !== undefined
        ? { parentCursor: params.parentCursor }
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
   */
  async ensure(params: {
    sessionId: string
    defaultConfig: AgentConfig
  }): Promise<SessionRecord> {
    const cached = this.records.get(params.sessionId)
    if (cached) return cached
    const inflight = this.inFlight.get(params.sessionId)
    if (inflight) return inflight
    const promise = this.ensureInner(params.sessionId, params.defaultConfig)
      .finally(() => {
        this.inFlight.delete(params.sessionId)
      })
    this.inFlight.set(params.sessionId, promise)
    return promise
  }

  private async ensureInner(
    sessionId: string,
    defaultConfig: AgentConfig,
  ): Promise<SessionRecord> {
    try {
      return await this.loadInner(sessionId)
    } catch {
      // No existing log — create a fresh one. `create` itself performs a
      // single writeHeader() which is the atomic commit point; if it
      // throws the sessionId stays uninstalled and the next caller can
      // retry.
      return await this.create({ sessionId, config: defaultConfig })
    }
  }

  async record(
    sessionId: string,
    event: AgentEvent,
    effects: readonly Effect[],
    nextState: AgentState,
    usageDelta?: UsageTotal,
  ): Promise<void> {
    const rec = this.records.get(sessionId)
    if (!rec) throw new Error(`Cannot record on unknown session: ${sessionId}`)
    await appendEventEntry({
      path: rec.logPath,
      seq: nextState.cursor,
      event,
      effects,
      ...(usageDelta ? { usage: usageDelta } : {}),
    })
    rec.state = nextState
  }

  list(): SessionRecord[] {
    return [...this.records.values()]
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
    const finalState = fold(parsed.header.initialState, events, parsed.header.config)
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
    }
    this.records.set(sessionId, record)
    return record
  }
}
