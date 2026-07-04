/**
 * Socket.IO server with `/dashboard` and `/executor` namespaces.
 *
 * Owns handshake auth, room fan-out, and the wiring from wire events to the
 * host loop's `dispatch`. Keep protocol-mapping code here; keep semantics in
 * the loop.
 */

import { createServer, type Server as HttpServer } from 'node:http'

import type {
  ClientCancel,
  ClientFork,
  ClientSubscribe,
  ClientUserApprove,
  ClientUserMessage,
  ClientUserReject,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ExecutorToolResult,
  HandshakeAuth,
  SessionErrorEvent,
  SessionErrorScope,
  SessionForkedEvent,
  SessionReadyEvent,
} from '@agent-kernel/shared'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  Effect,
  RequestApprovalEffect,
} from '@agent-kernel/kernel'
import { fold } from '@agent-kernel/kernel'
import { Server as IOServer, type Namespace } from 'socket.io'
import { ulid } from 'ulid'

import type { LLMAdapter } from './llm/adapter.js'
import type { LoopBroadcast, LoopHandle } from './loop.js'
import { runHostLoop } from './loop.js'
import { readSessionLog } from './store/log.js'
import { SessionStore, type SessionRecord } from './store/session.js'
import {
  createExecutorRegistry,
  DEFAULT_TOOL_TIMEOUT_MS,
} from './connection/executor.js'

export type HostServerOptions = {
  port: number
  sessionsDir: string
  llm: LLMAdapter
  defaultConfig: AgentConfig
  toolTimeoutMs?: number
  authToken?: string
  httpServer?: HttpServer
}

export type HostServer = {
  readonly io: IOServer
  readonly http: HttpServer
  readonly loop: LoopHandle
  readonly store: SessionStore
  readonly port: number
  close(): Promise<void>
}

type DashboardNs = Namespace<
  DashboardClientToServerEvents,
  DashboardServerToClientEvents
>
type ExecutorNs = Namespace<
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents
>

export async function startHostServer(
  options: HostServerOptions,
): Promise<HostServer> {
  const http = options.httpServer ?? createServer()
  const io = new IOServer(http, {
    cors: { origin: '*' },
  })

  const store = new SessionStore(options.sessionsDir)
  const executors = createExecutorRegistry(
    io,
    options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  )

  const dashboardNs: DashboardNs = io.of('/dashboard')
  const executorNs: ExecutorNs = io.of('/executor')

  const broadcast: LoopBroadcast = {
    onEvent(sessionId, seq, event, effects, state) {
      const room = `session:${sessionId}`
      io.of('/dashboard').to(room).emit('event:appended', {
        sessionId,
        seq,
        ts: new Date().toISOString(),
        event,
        effects,
      })
      io.of('/dashboard').to(room).emit('state:changed', {
        sessionId,
        cursor: state.cursor,
        state,
      })
      io.of('/executor').to(room).emit('event:appended', {
        sessionId,
        seq,
        ts: new Date().toISOString(),
        event,
        effects,
      })
      io.of('/executor').to(room).emit('state:changed', {
        sessionId,
        cursor: state.cursor,
        state,
      })
    },
    onApprovalRequired(sessionId, eff: RequestApprovalEffect) {
      io.of('/dashboard').to(`session:${sessionId}`).emit('approval:required', {
        sessionId,
        callId: eff.callId,
        name: eff.name,
        input: eff.input,
      })
    },
    onError(sessionId, message) {
      const payload: SessionErrorEvent = {
        sessionId,
        scope: 'llm',
        message,
      }
      io.of('/dashboard').to(`session:${sessionId}`).emit('session:error', payload)
      io.of('/executor').to(`session:${sessionId}`).emit('session:error', payload)
    },
    onUsageChanged(sessionId, state) {
      io.of('/dashboard').to(`session:${sessionId}`).emit('usage:updated', {
        sessionId,
        usage: state.usage,
      })
    },
  }

  const loop = runHostLoop({
    store,
    llm: options.llm,
    tools: executors,
    broadcast,
  })

  configureDashboardNamespace(dashboardNs, {
    store,
    loop,
    defaultConfig: options.defaultConfig,
    authToken: options.authToken,
    broadcastError,
  })
  configureExecutorNamespace(executorNs, {
    store,
    executors,
    defaultConfig: options.defaultConfig,
    authToken: options.authToken,
    broadcastError,
  })

  function broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void {
    const payload: SessionErrorEvent = { sessionId, scope, message }
    dashboardNs.to(`session:${sessionId}`).emit('session:error', payload)
    executorNs.to(`session:${sessionId}`).emit('session:error', payload)
  }

  await new Promise<void>((resolve) => {
    if (http.listening) {
      resolve()
      return
    }
    http.listen(options.port, () => resolve())
  })
  const addr = http.address()
  const port =
    typeof addr === 'object' && addr && 'port' in addr ? addr.port : options.port

  return {
    io,
    http,
    loop,
    store,
    port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        io.close((err) => (err ? reject(err) : resolve()))
      })
      await new Promise<void>((resolve) => {
        http.close(() => resolve())
      })
    },
  }
}

// ============================================================================
// Dashboard namespace
// ============================================================================

type DashboardDeps = {
  store: SessionStore
  loop: LoopHandle
  defaultConfig: AgentConfig
  authToken?: string
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
}

function configureDashboardNamespace(ns: DashboardNs, deps: DashboardDeps): void {
  ns.use((socket, nextFn) => {
    const auth = socket.handshake.auth as HandshakeAuth | undefined
    if (!auth || auth.role !== 'dashboard') {
      nextFn(new Error('role_mismatch'))
      return
    }
    if (deps.authToken && auth.token !== deps.authToken) {
      nextFn(new Error('auth_failed'))
      return
    }
    if (!auth.sessionId) {
      nextFn(new Error('missing_session_id'))
      return
    }
    nextFn()
  })

  ns.on('connection', async (socket) => {
    const auth = socket.handshake.auth as HandshakeAuth
    const record = await deps.store.ensure({
      sessionId: auth.sessionId,
      defaultConfig: deps.defaultConfig,
    })
    await socket.join(`session:${auth.sessionId}`)
    const ready: SessionReadyEvent = readyEventFor(record)
    socket.emit('session:ready', ready)

    socket.on('subscribe', async ({ sessionId }: ClientSubscribe) => {
      let target = deps.store.get(sessionId)
      if (!target) {
        try {
          target = await deps.store.load(sessionId)
        } catch {
          deps.broadcastError(sessionId, 'host', 'unknown session')
          return
        }
      }
      await socket.join(`session:${sessionId}`)
      const payload: SessionReadyEvent = readyEventFor(target)
      socket.emit('session:ready', payload)
    })

    socket.on('client:user_message', async (p: ClientUserMessage) => {
      const evt: AgentEvent = { kind: 'user_message', text: p.text }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:user_approve', async (p: ClientUserApprove) => {
      const evt: AgentEvent = { kind: 'user_approve', callId: p.callId }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:user_reject', async (p: ClientUserReject) => {
      const evt: AgentEvent = {
        kind: 'user_reject',
        callId: p.callId,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:cancel', async (p: ClientCancel) => {
      const evt: AgentEvent = { kind: 'cancel' }
      await safeDispatch(deps, p.sessionId, evt)
    })
    socket.on('client:fork', async (p: ClientFork) => {
      try {
        const source = await deps.store.load(p.sourceSessionId)
        const parsed = await readSessionLog(source.logPath)
        const keptEvents = parsed.events
          .filter((e) => e.seq <= p.cursor)
          .map((e) => e.event)
        const forkedState: AgentState = fold(
          parsed.header.initialState,
          keptEvents,
          parsed.header.config,
        )
        const newId = p.newSessionId ?? ulid()
        const record = await deps.store.create({
          sessionId: newId,
          config: source.config,
          parentSessionId: p.sourceSessionId,
          parentCursor: p.cursor,
          initialState: forkedState,
        })
        await socket.join(`session:${record.sessionId}`)
        const forked: SessionForkedEvent = {
          sessionId: record.sessionId,
          parentSessionId: p.sourceSessionId,
          parentCursor: p.cursor,
          cursor: record.state.cursor,
          state: record.state,
          config: record.config,
        }
        socket.emit('session:forked', forked)
      } catch (err) {
        deps.broadcastError(
          p.sourceSessionId,
          'host',
          err instanceof Error ? err.message : String(err),
        )
      }
    })
  })
}

async function safeDispatch(
  deps: DashboardDeps,
  sessionId: string,
  event: AgentEvent,
): Promise<void> {
  try {
    await deps.loop.dispatch(sessionId, event)
  } catch (err) {
    deps.broadcastError(
      sessionId,
      'kernel',
      err instanceof Error ? err.message : String(err),
    )
  }
}

function readyEventFor(record: SessionRecord): SessionReadyEvent {
  return {
    sessionId: record.sessionId,
    cursor: record.state.cursor,
    state: record.state,
    config: record.config,
    ...(record.parentSessionId
      ? { parentSessionId: record.parentSessionId }
      : {}),
    ...(record.parentCursor !== undefined
      ? { parentCursor: record.parentCursor }
      : {}),
  }
}

// ============================================================================
// Executor namespace
// ============================================================================

type ExecutorDeps = {
  store: SessionStore
  executors: ReturnType<typeof createExecutorRegistry>
  defaultConfig: AgentConfig
  authToken?: string
  broadcastError(
    sessionId: string,
    scope: SessionErrorScope,
    message: string,
  ): void
}

function configureExecutorNamespace(ns: ExecutorNs, deps: ExecutorDeps): void {
  ns.use((socket, nextFn) => {
    const auth = socket.handshake.auth as HandshakeAuth | undefined
    if (!auth || auth.role !== 'executor') {
      nextFn(new Error('role_mismatch'))
      return
    }
    if (deps.authToken && auth.token !== deps.authToken) {
      nextFn(new Error('auth_failed'))
      return
    }
    if (!auth.sessionId) {
      nextFn(new Error('missing_session_id'))
      return
    }
    nextFn()
  })

  ns.on('connection', async (socket) => {
    const auth = socket.handshake.auth as HandshakeAuth
    // Wire-protocol  - 2: only dashboard handshakes may create unknown
    // sessions in v1. Executors are pure RPC responders and must attach
    // to an already-created session. If the session isn't in memory OR
    // on disk yet, close the socket with the normative `unknown_session`
    // reason ( - 2). Socket.IO retries will succeed once the dashboard
    // has created the session.
    let record: SessionRecord
    try {
      record = deps.store.get(auth.sessionId) ?? (await deps.store.load(auth.sessionId))
    } catch {
      socket.emit('session:error', {
        sessionId: auth.sessionId,
        scope: 'host',
        message: 'unknown_session',
      })
      socket.disconnect(true)
      return
    }
    await socket.join(`session:${auth.sessionId}`)
    const ready: SessionReadyEvent = readyEventFor(record)
    socket.emit('session:ready', ready)

    socket.on('executor:announce', (payload: ExecutorAnnounce) => {
      deps.executors.attach(payload.sessionId, socket, payload)
    })
    socket.on('executor:tool_result', (payload: ExecutorToolResult) => {
      deps.executors.fulfill(payload.sessionId, payload)
    })
    socket.on('disconnect', () => {
      deps.executors.detach(socket)
    })
  })
}
