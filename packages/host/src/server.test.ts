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
  SessionForkedEvent,
  SessionReadyEvent,
  ToolCallMessage,
  ToolResultAck,
} from '@agent-kernel/shared'
import { SESSION_ERROR_SCOPES } from '@agent-kernel/shared'
import { io as clientIO, type Socket as ClientSocket } from 'socket.io-client'

import type { LLMAdapter } from './llm/adapter.js'
import { startHostServer, type HostServer } from './server.js'

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
      auth: { sessionId, role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      executor.on('session:ready', resolve),
    )
    executor.emit('executor:announce', {
      sessionId,
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

    // Wait until the server has registered the announcement so the loop can
    // dispatch tool calls to a bound executor.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = (): void => {
        const anyReg = server.io.of('/executor').sockets.size > 0
        if (anyReg) return resolve()
        if (Date.now() - start > 1000)
          return reject(new Error('announce wait timeout'))
        setTimeout(tick, 10)
      }
      tick()
    })

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
      auth: { sessionId, role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      executor.on('session:ready', resolve),
    )
    executor.emit('executor:announce', {
      sessionId,
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
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = (): void => {
        if (server.io.of('/executor').sockets.size > 0) return resolve()
        if (Date.now() - start > 1000)
          return reject(new Error('announce wait timeout'))
        setTimeout(tick, 10)
      }
      tick()
    })
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
      auth: { sessionId, role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      executor.on('session:ready', resolve),
    )
    executor.emit('executor:announce', {
      sessionId,
      executorId: 'ex-cancel',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })

    // Deliberately do NOT ack tool:call — we want the pending call to be
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

    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = (): void => {
        if (server.io.of('/executor').sockets.size > 0) return resolve()
        if (Date.now() - start > 1000)
          return reject(new Error('announce wait timeout'))
        setTimeout(tick, 10)
      }
      tick()
    })

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

  it('rejects an executor handshake for an unknown session (wire-protocol §2)', async () => {
    // Regression for reviewer R2: v1 protocol says only dashboards may
    // create unknown sessions. The prior fix incorrectly let an executor
    // auto-create a session by connecting first, which would allow an
    // executor-only deployment to bypass dashboard bookkeeping and land
    // an orphan session on disk.
    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: {
        sessionId: 'ghost-session-never-created',
        role: 'executor',
        clientVersion: '0.0.0',
      },
      reconnection: false,
    })

    const outcome = await new Promise<
      | { kind: 'error'; scope: string; message: string }
      | { kind: 'disconnected'; reason: string }
    >((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('never observed rejection or disconnect')),
        3000,
      )
      let sawError: { scope: string; message: string } | undefined
      executor.on('session:error', (payload) => {
        sawError = { scope: payload.scope, message: payload.message }
      })
      executor.on('disconnect', (reason) => {
        clearTimeout(timer)
        if (sawError) {
          resolve({ kind: 'error', ...sawError })
        } else {
          resolve({ kind: 'disconnected', reason })
        }
      })
      // If session:ready fires, the test fails — that would mean we let
      // the executor auto-create.
      executor.on('session:ready', () => {
        clearTimeout(timer)
        reject(new Error('executor was allowed to create the session'))
      })
    })

    if (outcome.kind === 'error') {
      expect(outcome.scope).toBe('host')
      expect(outcome.message).toBe('unknown_session')
    } else {
      // Some socket.io configurations may drop before the error frame
      // makes it back. Either way, the socket ended up disconnected.
      expect(outcome.reason).toBeTruthy()
    }

    // No log file for the ghost session on disk.
    expect(server.store.get('ghost-session-never-created')).toBeUndefined()

    executor.close()
  })

  it('accepts an executor handshake for a session the dashboard already created', async () => {
    // Companion positive test for R2: after a dashboard creates the
    // session, the executor's next handshake must succeed. Otherwise the
    // fix over-rejects and breaks the normal boot order.
    const sessionId = 'wire-executor-late'

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
      auth: { sessionId, role: 'executor', clientVersion: '0.0.0' },
      reconnection: false,
    })
    const ready = await new Promise<SessionReadyEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('executor session:ready timeout')),
        2000,
      )
      executor.on('session:ready', (p) => {
        clearTimeout(timer)
        resolve(p)
      })
    })
    expect(ready.sessionId).toBe(sessionId)

    dashboard.close()
    executor.close()
  })
})

describe('protocol doc drift', () => {
  it('wire-protocol.md §3.4 session:error scope union matches SESSION_ERROR_SCOPES', async () => {
    // Reviewer round-2 observation: the shared TS type used `'host'` while
    // wire-protocol.md still said `'core'` — a leftover from ADR 0011
    // (rename `packages/core` → `packages/host`). The runtime enforced
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

    // Extract the scope union declared in the §3.4 code block. The line
    // shape is: `  scope: 'a' | 'b' | 'c' | 'd'`. Use a permissive regex
    // that tolerates spacing but pins the field name so unrelated `|`
    // characters in the doc don't match.
    const match = doc.match(/scope:\s*((?:'[a-z]+'\s*\|?\s*)+)/)
    expect(
      match,
      "wire-protocol.md §3.4 must declare a `scope: 'x' | 'y'` union",
    ).not.toBeNull()

    const docScopes = Array.from(match![1].matchAll(/'([a-z]+)'/g))
      .map((m) => m[1])
      .sort()
    const codeScopes = [...SESSION_ERROR_SCOPES].sort()

    expect(
      docScopes,
      `wire-protocol.md §3.4 scope union drifted from SESSION_ERROR_SCOPES ` +
        `(runtime enforces ${codeScopes.join(', ')} — see packages/shared/src/protocol.ts)`,
    ).toEqual(codeScopes)
  })
})
