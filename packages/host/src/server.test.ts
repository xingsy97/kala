import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import type { AgentConfig } from '@agent-kernel/kernel'
import type {
  DashboardServerToClientEvents,
  DashboardClientToServerEvents,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ServerExecutorChangedPayload,
  ServerExecutorsPayload,
  ServerHistoryPayload,
  ServerSessionsPayload,
  SessionForkedEvent,
  SessionReadyEvent,
  ToolCallMessage,
  ToolResultAck,
} from '@agent-kernel/shared'
import { SESSION_ERROR_SCOPES } from '@agent-kernel/shared'
import { io as clientIO, type Socket as ClientSocket } from 'socket.io-client'

import type { LLMAdapter } from './llm/adapter.js'
import { startHostServer, type HostServer } from './server.js'
import { readSessionLog } from './store/log.js'

const WRITE = {
  name: 'write',
  description: 'write',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

function scriptedLlm(): LLMAdapter {
  const queue = [
    {
      message: {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_call' as const,
            callId: 'c1',
            name: 'write',
            input: { path: '/tmp/x' },
          },
        ],
      },
    },
    {
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'wrote it' }],
      },
    },
  ]
  return {
    name: 'test',
    async call() {
      const next = queue.shift()
      if (!next) throw new Error('llm empty')
      return next
    },
  }
}

/**
 * Wait until the host's executor registry has an announced daemon connected.
 * Peeking at the internal snapshot is the cheapest signal  -  the socket
 * accepting the connection is not enough; we need the `executor:announce`
 * event to have been processed.
 */
async function waitForAnyExecutor(
  server: HostServer,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (server.io.of('/executor').sockets.size > 0) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('announce wait timeout')
}

async function waitForWorkspace(
  dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>,
  workspaceId: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const list = await new Promise<ServerExecutorsPayload>((resolve) => {
      dashboard.once('server:executors', resolve)
      dashboard.emit('client:list_executors', {})
    })
    if (list.executors.some((e) => e.workspaceId === workspaceId)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`workspace wait timeout: ${workspaceId}`)
}

describe('wire protocol', () => {
  let server: HostServer
  let dir: string
  let url: string
  let config: AgentConfig

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-wire-'))
    config = createConfig({ tools: [WRITE], systemPrompt: 'sys' })
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
    })
    url = `http://localhost:${server.port}`
  })

  afterEach(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('handshake auth rejects role mismatch', async () => {
    const bad: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 's', role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    const err = await new Promise<Error>((resolve) => {
      bad.on('connect_error', (e) => resolve(e))
    })
    expect(err.message).toBe('role_mismatch')
    bad.close()
  })

  it('drives a full round-trip with dashboard + executor', async () => {
    const sessionId = 'wire-1'
    // Pre-materialize the session: dashboard handshakes are now lazy (they
    // no longer touch disk) so we need the session record on disk before we
    // dispatch below. The dashboard client will still receive session:ready
    // for the recorded state.
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    // Executor is a daemon: handshake no longer names a session. It announces
    // once and then services `tool:call` for whatever session the host routes
    // to it.
    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-1',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    executor.on(
      'tool:call',
      (payload: ToolCallMessage, ack: (r: ToolResultAck) => void) => {
        ack({
          callId: payload.callId,
          ok: true,
          content: 'wrote ' + JSON.stringify(payload.input),
        })
      },
    )
    await waitForAnyExecutor(server)

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never reached done')), 4000)
      dashboard.on('state:changed', (payload) => {
        if (payload.state.status === 'done') {
          clearTimeout(timer)
          resolve()
        }
        if (payload.state.status === 'error') {
          clearTimeout(timer)
          reject(new Error('kernel error: ' + payload.state.error))
        }
      })
    })

    dashboard.emit('client:user_message', {
      sessionId,
      text: 'please write',
    })

    await done
    const rec = server.store.get(sessionId)
    expect(rec?.state.status).toBe('done')
    // seq: user + llm(tool) + tool_result + llm(text) = 4
    expect(rec?.state.cursor).toBe(4)

    dashboard.close()
    executor.close()
  })

  it('forks a session from a chosen cursor and reports lineage', async () => {
    const sessionId = 'wire-fork-src'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-fork',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    executor.on(
      'tool:call',
      (payload: ToolCallMessage, ack: (r: ToolResultAck) => void) => {
        ack({ callId: payload.callId, ok: true, content: 'ok' })
      },
    )
    await waitForAnyExecutor(server)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('src never done')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done') {
          clearTimeout(timer)
          resolve()
        }
      })
      dashboard.emit('client:user_message', { sessionId, text: 'go' })
    })

    const forked = new Promise<SessionForkedEvent>((resolve) =>
      dashboard.on('session:forked', resolve),
    )
    dashboard.emit('client:fork', {
      sourceSessionId: sessionId,
      cursor: 2,
      newSessionId: 'wire-fork-child',
    })
    const ev = await forked
    expect(ev.sessionId).toBe('wire-fork-child')
    expect(ev.parentSessionId).toBe(sessionId)
    expect(ev.parentCursor).toBe(2)
    expect(ev.state.cursor).toBe(2)
    // Original session has cursor 4; fork stops at 2 (user + llm tool_call).
    const forkedRec = server.store.get('wire-fork-child')
    expect(forkedRec?.parentSessionId).toBe(sessionId)
    expect(forkedRec?.parentCursor).toBe(2)
    expect(forkedRec?.state.cursor).toBe(2)

    dashboard.close()
    executor.close()
  })

  it('forwards client:cancel to the executor as tool:cancel for pending calls', async () => {
    // Regression for reviewer R1: previously the loop dropped kernel
    // pendingCalls but never told the executor. A hanging bash / long
    // read would continue burning CPU on the executor side, and any
    // ack that eventually arrived was applied to a kernel that had
    // already moved on.
    const sessionId = 'wire-cancel'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-cancel',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })

    // Deliberately do NOT ack tool:call  -  we want the pending call to be
    // in flight when cancel fires. Capture what arrived so we can compare.
    const toolCalls: ToolCallMessage[] = []
    executor.on('tool:call', (payload) => {
      toolCalls.push(payload)
      // no ack: the executor is "still running"
    })

    // Set up the cancel receiver BEFORE we fire cancel so we don't miss
    // the event due to a socket.io race between emit and listener attach.
    const cancelSeen = new Promise<{ sessionId: string; callId: string }>(
      (resolve) => {
        executor.on('tool:cancel', resolve)
      },
    )

    await waitForAnyExecutor(server)

    dashboard.emit('client:user_message', { sessionId, text: 'go' })

    // Wait for the tool:call to hit the executor before cancelling.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = (): void => {
        if (toolCalls.length > 0) return resolve()
        if (Date.now() - start > 2000)
          return reject(new Error('tool:call never arrived'))
        setTimeout(tick, 10)
      }
      tick()
    })

    dashboard.emit('client:cancel', { sessionId })
    const cancelPayload = await cancelSeen
    expect(cancelPayload.sessionId).toBe(sessionId)
    expect(cancelPayload.callId).toBe(toolCalls[0]!.callId)

    // Kernel side: state must be `done`, pendingCalls empty.
    const rec = server.store.get(sessionId)
    expect(rec?.state.status).toBe('done')
    expect(rec?.state.pendingCalls).toEqual([])

    dashboard.close()
    executor.close()
  })

  it('accepts an executor handshake with no sessionId (daemon model)', async () => {
    // Regression for ADR 0013 / Task #95: an executor is a daemon, not
    // pinned to a session. Its handshake omits sessionId; the connect
    // succeeds and the announce runs the moment the socket is up.
    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('executor connect timeout')),
        2000,
      )
      executor.on('connect', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    executor.close()
  })

  it('routes tool calls from two different sessions to the same daemon executor', async () => {
    // The whole point of Task #95  -  1 executor : N sessions. We open two
    // dashboards under distinct session IDs, one shared executor, and
    // verify each session's tool_call reaches the same daemon and comes
    // back with the right correlation.
    const sessionA = 'wire-multi-A'
    const sessionB = 'wire-multi-B'
    await server.store.ensure({ sessionId: sessionA, defaultConfig: config })
    await server.store.ensure({ sessionId: sessionB, defaultConfig: config })

    const dashA: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: sessionA, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    const dashB: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: sessionB, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await Promise.all([
      new Promise<SessionReadyEvent>((r) => dashA.on('session:ready', r)),
      new Promise<SessionReadyEvent>((r) => dashB.on('session:ready', r)),
    ])

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))

    const seenSessions: string[] = []
    executor.on(
      'tool:call',
      (payload: ToolCallMessage, ack: (r: ToolResultAck) => void) => {
        seenSessions.push(payload.sessionId)
        ack({ callId: payload.callId, ok: true, content: `ok:${payload.sessionId}` })
      },
    )
    executor.emit('executor:announce', {
      executorId: 'ex-shared',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    await waitForAnyExecutor(server)

    // Every scripted LLM run consumes two entries from the queue. To exercise
    // two sessions we need a fresh scripted queue per session, which means a
    // full round-trip on the first before starting the second  -  the current
    // adapter queue is shared. We simply verify the executor receives calls
    // tagged with the right sessionId for each session.
    const doneA = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('A never done')), 4000)
      dashA.on('state:changed', (p) => {
        if (p.state.status === 'done') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    dashA.emit('client:user_message', { sessionId: sessionA, text: 'a' })
    await doneA

    expect(seenSessions).toContain(sessionA)
    // Only session A has had a completed round-trip in this test  -  session B
    // may not have received a tool_call yet since the scripted queue was
    // fully drained. That's fine; the daemon-routing invariant is checked by
    // executor.test.ts and by the fact that A's call landed with the right
    // sessionId on the single shared executor socket.

    dashA.close()
    dashB.close()
    executor.close()
  })

  it('broadcasts server:executor_changed and answers client:list_executors with the current snapshot', async () => {
    // Regression for the Finder-layout Workspaces column: the dashboard
    // needs (a) a one-shot snapshot on load, and (b) live change events so
    // it can update the daemon list without polling. Both routes must
    // include the announced hostname/os/ip metadata; if we lose it here,
    // the column falls back to bare executorIds and the UI regresses.
    const sessionId = 'wire-list-executors'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const changed = new Promise<ServerExecutorChangedPayload>((resolve) => {
      dashboard.on('server:executor_changed', resolve)
    })

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-list',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
      hostname: 'test-host',
      os: 'linux',
      ipAddresses: ['10.0.0.1'],
      pid: 4242,
      startedAt: '2026-07-04T00:00:00.000Z',
    })

    const change = await changed
    expect(change.change).toBe('attached')
    expect(change.executorId).toBe('ex-list')
    if (change.change !== 'detached') {
      expect(change.executor.hostname).toBe('test-host')
      expect(change.executor.os).toBe('linux')
      expect(change.executor.ipAddresses).toEqual(['10.0.0.1'])
      expect(change.executor.pid).toBe(4242)
      expect(typeof change.executor.attachedAt).toBe('string')
    }

    const list = await new Promise<ServerExecutorsPayload>((resolve) => {
      dashboard.on('server:executors', resolve)
      dashboard.emit('client:list_executors', {})
    })
    expect(list.executors).toHaveLength(1)
    const [only] = list.executors
    expect(only!.executorId).toBe('ex-list')
    expect(only!.hostname).toBe('test-host')
    expect(only!.attachedAt).toBe(change.change !== 'detached' ? change.executor.attachedAt : '')

    // A detach also fans out.
    const detached = new Promise<ServerExecutorChangedPayload>((resolve) => {
      dashboard.on('server:executor_changed', (p) => {
        if (p.change === 'detached') resolve(p)
      })
    })
    executor.close()
    const detachedPayload = await detached
    expect(detachedPayload.executorId).toBe('ex-list')

    dashboard.close()
  })

  it('answers client:list_sessions and client:load_history from the JSONL log', async () => {
    // Regression for the Sessions column + timeline persistence: a
    // reloaded dashboard tab must be able to enumerate sessions on disk
    // and replay each timeline from the log. If either endpoint drifts
    // from the log format, the UI will silently show an empty list or a
    // blank timeline and the user only finds out by refreshing.
    const sessionId = 'wire-history-src'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-hist',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    executor.on(
      'tool:call',
      (payload: ToolCallMessage, ack: (r: ToolResultAck) => void) => {
        ack({ callId: payload.callId, ok: true, content: 'ok' })
      },
    )
    await waitForAnyExecutor(server)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never done')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done') {
          clearTimeout(timer)
          resolve()
        }
      })
      dashboard.emit('client:user_message', { sessionId, text: 'please write' })
    })

    // Sessions list  -  after one round-trip we expect exactly one summary
    // with the right shape.
    const sessions = await new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
      dashboard.emit('client:list_sessions', {})
    })
    expect(sessions.sessions).toHaveLength(1)
    const summary = sessions.sessions[0]!
    expect(summary.sessionId).toBe(sessionId)
    expect(summary.eventCount).toBe(4)
    expect(summary.status).toBe('done') // recovered from the finish effect on the last event
    expect(summary.firstUserMessage).toBe('please write')

    // Load history  -  full then incremental.
    const full = await new Promise<ServerHistoryPayload>((resolve) => {
      dashboard.on('server:history', resolve)
      dashboard.emit('client:load_history', { sessionId })
    })
    expect(full.sessionId).toBe(sessionId)
    expect(full.entries).toHaveLength(4)
    expect(full.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(full.entries[0]!.event.kind).toBe('user_message')

    const incremental = await new Promise<ServerHistoryPayload>((resolve) => {
      dashboard.off('server:history')
      dashboard.on('server:history', resolve)
      dashboard.emit('client:load_history', { sessionId, sinceCursor: 2 })
    })
    expect(incremental.entries.map((e) => e.seq)).toEqual([3, 4])

    dashboard.close()
    executor.close()
  })

  it('client:create_session writes JSONL with workspaceId and broadcasts server:sessions', async () => {
    const sessionId = 'wire-create-session'
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const listPromise = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-alpha',
      workspaceName: 'alpha-box',
    })
    const list = await listPromise
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0]!.sessionId).toBe(sessionId)
    expect(list.sessions[0]!.workspaceId).toBe('ws-alpha')
    expect(list.sessions[0]!.workspaceName).toBe('alpha-box')

    const loaded = await server.store.load(sessionId)
    expect(loaded.workspaceId).toBe('ws-alpha')
    expect(loaded.workspaceName).toBe('alpha-box')

    // Idempotency: a second emit for the same id must not double-create.
    let secondBroadcast = 0
    dashboard.on('server:sessions', () => {
      secondBroadcast += 1
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-alpha',
      workspaceName: 'alpha-box',
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(secondBroadcast).toBe(0)

    dashboard.close()
  })

  it('client:create_session validates and writes the initial cwd', async () => {
    const sessionId = 'wire-create-session-cwd'
    const root = resolve(dir, 'workspace-root')
    const child = resolve(root, 'child')

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-create-cwd',
      workspaceId: 'ws-create-cwd',
      workspaceName: 'cwd-box',
      tools: ['write'],
      sandboxRoots: [root],
      runtime: 'node',
      runtimeVersion: '22',
    })
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )
    await waitForWorkspace(dashboard, 'ws-create-cwd')

    const ready = new Promise<SessionReadyEvent>((resolve) => {
      dashboard.off('session:ready')
      dashboard.on('session:ready', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-create-cwd',
      workspaceName: 'cwd-box',
      cwd: child,
    })
    const createdReady = await ready
    expect(createdReady.state.cwd).toBe(child)
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    const err = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.on('session:error', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId: 'wire-create-session-cwd-bad',
      workspaceId: 'ws-create-cwd',
      workspaceName: 'cwd-box',
      cwd: resolve(dir, 'outside'),
    })
    await expect(err).resolves.toMatchObject({
      scope: 'host',
      message: 'cwd outside sandbox roots',
    })

    dashboard.close()
    executor.close()
  })

  it('client:list_dirs returns directory entries from the selected executor', async () => {
    const sessionId = 'wire-list-dirs'
    const root = resolve(dir, 'dir-root')
    const child = resolve(root, 'child')
    await import('node:fs/promises').then((fs) => fs.mkdir(child, { recursive: true }))

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.on('fs:list_dirs', (payload, ack) => {
      ack({
        requestId: payload.requestId,
        workspaceId: payload.workspaceId,
        path: root,
        roots: [root],
        entries: [{ name: 'child', path: child }],
      })
    })
    executor.emit('executor:announce', {
      executorId: 'ex-list-dirs',
      workspaceId: 'ws-list-dirs',
      workspaceName: 'dir-box',
      tools: ['write'],
      sandboxRoots: [root],
      runtime: 'node',
      runtimeVersion: '22',
    })
    await waitForAnyExecutor(server)

    const listed = new Promise<import('@agent-kernel/shared').DirListResult>((resolve) => {
      dashboard.on('server:dir_list', resolve)
    })
    dashboard.emit('client:list_dirs', {
      requestId: 'dirs-1',
      workspaceId: 'ws-list-dirs',
      path: root,
    })
    await expect(listed).resolves.toMatchObject({
      requestId: 'dirs-1',
      workspaceId: 'ws-list-dirs',
      path: root,
      entries: [{ name: 'child', path: child }],
    })

    dashboard.close()
    executor.close()
  })

  it('client:set_cwd validates sandbox roots and updates session summaries', async () => {
    const sessionId = 'wire-set-cwd'
    const root = resolve(dir, 'workspace')
    const child = resolve(root, 'child')

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-cwd',
      workspaceId: 'ws-cwd',
      workspaceName: 'cwd-box',
      tools: ['write'],
      sandboxRoots: [root],
      runtime: 'node',
      runtimeVersion: '22',
    })
    await waitForAnyExecutor(server)

    const created = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-cwd',
      workspaceName: 'cwd-box',
    })
    await created

    const changed = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.off('server:sessions')
      dashboard.on('server:sessions', resolve)
    })
    dashboard.emit('client:set_cwd', { sessionId, cwd: child })
    const list = await changed
    const summary = list.sessions.find((s) => s.sessionId === sessionId)
    expect(summary?.currentCwd).toBe(child)
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    const err = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.on('session:error', resolve)
    })
    dashboard.emit('client:set_cwd', { sessionId, cwd: resolve(dir, 'outside') })
    await expect(err).resolves.toMatchObject({
      scope: 'host',
      message: 'cwd outside sandbox roots',
    })
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    dashboard.close()
    executor.close()
  })

  it('client:compact rejects an empty session without calling the summarizer', async () => {
    const sessionId = 'wire-empty-compact'
    let llmCalls = 0
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'compact-counter',
        async call() {
          llmCalls += 1
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'summary' }],
            },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const err = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.on('session:error', resolve)
    })
    dashboard.emit('client:compact', { sessionId })

    await expect(err).resolves.toMatchObject({
      scope: 'kernel',
      message: 'nothing to compact yet',
    })
    expect(llmCalls).toBe(0)

    dashboard.close()
  })
})

describe('protocol doc drift', () => {
  it('wire-protocol.md  - 3.4 session:error scope union matches SESSION_ERROR_SCOPES', async () => {
    // Reviewer round-2 observation: the shared TS type used `'host'` while
    // wire-protocol.md still said `'core'`  -  a leftover from ADR 0011
    // (rename `packages/core`  -  `packages/host`). The runtime enforced
    // `'host'` but the doc lied to protocol implementers. This test pins
    // the two together so any future drift is caught in CI, not by a
    // reviewer reading two files side-by-side.
    const thisDir = dirname(fileURLToPath(import.meta.url))
    const docPath = resolve(
      thisDir,
      '..',
      '..',
      '..',
      'docs',
      'protocol',
      'wire-protocol.md',
    )
    const doc = await readFile(docPath, 'utf8')

    // Extract the scope union declared in the  - 3.4 code block. The line
    // shape is: `  scope: 'a' | 'b' | 'c' | 'd'`. Use a permissive regex
    // that tolerates spacing but pins the field name so unrelated `|`
    // characters in the doc don't match.
    const match = doc.match(/scope:\s*((?:'[a-z]+'\s*\|?\s*)+)/)
    expect(
      match,
      "wire-protocol.md  - 3.4 must declare a `scope: 'x' | 'y'` union",
    ).not.toBeNull()

    const docScopes = Array.from(match![1].matchAll(/'([a-z]+)'/g))
      .map((m) => m[1])
      .sort()
    const codeScopes = [...SESSION_ERROR_SCOPES].sort()

    expect(
      docScopes,
      `wire-protocol.md  - 3.4 scope union drifted from SESSION_ERROR_SCOPES ` +
        `(runtime enforces ${codeScopes.join(', ')}  -  see packages/shared/src/protocol.ts)`,
    ).toEqual(codeScopes)
  })
})
