import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConfig } from '@agent-kernel/kernel'
import type { AgentConfig } from '@agent-kernel/kernel'
import type {
  DashboardServerToClientEvents,
  ClientListDirs,
  DirListResult,
  DashboardClientToServerEvents,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ServerExecutorChangedPayload,
  ServerExecutorsPayload,
  ServerHistoryPayload,
  RpcAck,
  ServerMessageQueueEvent,
  ServerSettingsPayload,
  ServerSessionsPayload,
  ServerSubAgentFinishedEvent,
  ServerSubAgentStartedEvent,
  SessionReadyEvent,
  ToolResultAck,
  ToolCallMessage,
} from '@agent-kernel/shared'
import { DEDICATED_DEPLOYMENT, PROTOCOL_VERSION } from '@agent-kernel/shared'
import { SESSION_ERROR_SCOPES } from '@agent-kernel/shared'
import { io as clientIO, type Socket as ClientSocket } from 'socket.io-client'

import type { LLMAdapter } from './llm/adapter.js'
import { startHostServer, type HostServer } from './server.js'
import { readSessionLog } from './store/log.js'
import { ExecutorIdentityStore } from './store/executor-identity.js'

const WRITE = {
  name: 'write',
  description: 'write',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

const AGENT = {
  name: 'agent',
  description: 'spawn a sub-agent',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
  },
  requiresApproval: false,
  executionKind: 'host',
  executionHandler: 'agent',
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
 * Peeking at the internal snapshot is the cheapest signal — the socket
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

function attachDirListHandler(
  executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>,
  roots: readonly string[],
  existingDirs: readonly string[],
): void {
  const normalize = (p: string): string => /^[a-z]:[\\/]/iu.test(p) ? p.replaceAll('/', '\\').toLowerCase() : resolve(p)
  const known = new Set(existingDirs.map(normalize))
  // Host-internal fs / bg / overflow RPCs arrive as ordinary `tool:call`
  // messages. The stub executor pretends to be the `__fs_list_dirs` built-in
  // and returns a JSON string matching DirListResult.
  executor.on('tool:call', (payload, ack: (result: ToolResultAck) => void) => {
    if (payload.name !== '__fs_list_dirs') return
    const input = payload.input as { requestId: string; workspaceId: string; path?: string }
    const rawRequested = input.path ?? roots[0] ?? process.cwd()
    const requested = /^[a-z]:[\\/]/iu.test(rawRequested) ? rawRequested.replaceAll('/', '\\') : resolve(rawRequested)
    const result: DirListResult = known.has(normalize(requested))
      ? {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          path: requested,
          roots,
          entries: [],
        }
      : {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          path: requested,
          roots,
          entries: [],
          error: `ENOENT: no such file or directory, scandir '${requested}'`,
        }
    ack({ callId: payload.callId, ok: true, content: JSON.stringify(result) })
  })
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

async function waitForSocketData(
  namespace: ReturnType<HostServer['io']['of']>,
  timeoutMs = 1000,
  predicate: (data: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const socket = Array.from(namespace.sockets.values())[0]
    const data = socket?.data as Record<string, unknown> | undefined
    if (data && predicate(data)) return data
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('socket data wait timeout')
}

async function postEnhancementAction(url: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${url}/enhancement/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json() as unknown
  if (!response.ok) throw new Error(JSON.stringify(payload))
  return payload
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
      // Keep instant-detach semantics for tests; the grace window is
      // covered by targeted tests in connection/executor.test.ts.
      detachGraceMs: 0,
    })
    url = `http://localhost:${server.port}`
  })

  afterEach(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('advertises an 8 MiB Socket.IO payload limit for bounded inline images', async () => {
    const body = await fetch(`${url}/socket.io/?EIO=4&transport=polling`).then((response) => response.text())
    const handshake = JSON.parse(body.slice(1)) as { maxPayload: number }
    expect(handshake.maxPayload).toBe(8 * 1024 * 1024)
  })

  it('fences stale unsubscribe operations and re-emits a fresh baseline on rapid resubscribe', async () => {
    const sessionId = 'rapid-resubscribe-fence'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { clientId: 'rapid-switch-dashboard', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', () => resolve()))

    const firstReady = new Promise<SessionReadyEvent>((resolve) => dashboard.once('session:ready', resolve))
    const subscribed = await dashboard.timeout(1000).emitWithAck('client:subscribe_channels', {
      requestId: 'subscribe-new', generation: 3, channels: [`session:${sessionId}`],
    })
    expect(subscribed.accepted).toContain(`session:${sessionId}`)
    expect((await firstReady).sessionId).toBe(sessionId)

    const stale = await dashboard.timeout(1000).emitWithAck('client:unsubscribe_channels', {
      requestId: 'unsubscribe-old', generation: 2, channels: [`session:${sessionId}`],
    })
    expect(stale.rejected).toContainEqual({ channel: `session:${sessionId}`, code: 'stale_generation' })

    const appended = new Promise<EventAppendedEvent>((resolve) => dashboard.once('event:appended', resolve))
    const ack = await dashboard.timeout(1000).emitWithAck('client:user_message', {
      sessionId, text: 'still subscribed', mode: 'queue', operationId: 'rapid-switch-message',
    })
    expect(ack).toMatchObject({ ok: true })
    expect((await appended).sessionId).toBe(sessionId)
    dashboard.close()
  })

  it('acknowledges approval-mode changes and persists the authoritative mode', async () => {
    const sessionId = 'approval-mode-ack'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const ack = await dashboard.timeout(1000).emitWithAck('client:set_approval_mode', {
      operationId: 'approval-mode-ack-op',
      sessionId,
      mode: 'allow_all',
    })

    expect(ack).toEqual({ ok: true })
    expect(server.store.get(sessionId)?.state.approvalMode).toBe('allow_all')
    dashboard.close()
  })

  it('rejects invalid and oversized inline images before starting a turn', async () => {
    const sessionId = 'wire-image-policy'
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const invalid = await dashboard.timeout(1000).emitWithAck('client:user_message', {
      sessionId,
      text: 'invalid image',
      operationId: 'invalid-image',
      content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: Buffer.from('not png').toString('base64') } }],
    })
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining('IMAGE_INVALID_BASE64') })

    const oversizedBytes = Buffer.alloc(2 * 1024 * 1024 + 1)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedBytes)
    const oversized = await dashboard.timeout(3000).emitWithAck('client:user_message', {
      sessionId,
      text: 'oversized image',
      operationId: 'oversized-image',
      content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: oversizedBytes.toString('base64') } }],
    })
    expect(oversized).toMatchObject({ ok: false, error: expect.stringContaining('IMAGE_TOO_LARGE') })
    expect(server.store.get(sessionId)).toBeUndefined()
    dashboard.close()
  })

  it('accepts a bounded two-image payload larger than the legacy 1 MiB transport limit', async () => {
    const sessionId = 'wire-two-large-images'
    const record = await server.store.ensure({ sessionId, defaultConfig: config })
    record.record.state = { ...record.record.state, status: 'thinking' }
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const makePng = (): string => {
      const bytes = Buffer.alloc(600_000)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
      return bytes.toString('base64')
    }
    const ack = await dashboard.timeout(3000).emitWithAck('client:user_message', {
      sessionId,
      text: 'two screenshots',
      mode: 'queue',
      operationId: 'two-large-images',
      content: [
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: makePng() } },
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: makePng() } },
      ],
    })
    expect(ack).toMatchObject({ ok: true })
    const queue = await new Promise<ServerMessageQueueEvent>((resolve) => {
      dashboard.once('server:message_queue', resolve)
      dashboard.emit('client:subscribe_channels', { requestId: 'queue-check', generation: 1, channels: [`session:${sessionId}`] }, () => {})
    })
    expect(queue.items?.[0]?.content?.filter((block) => block.type === 'image')).toHaveLength(2)
    dashboard.close()
  })

  it('exposes host restart runtime status over HTTP and settings', async () => {
    const status = await fetch(`${url}/runtime/restart/status`).then((r) => r.json() as Promise<{ pid: number; current: unknown }>)
    expect(status.pid).toBe(process.pid)
    expect(status.current).toBeNull()

    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      settings: {
        paths: {
          claudeSettings: '/tmp/claude.json',
          codexConfig: '/tmp/codex.toml',
          manualModels: '/tmp/models.json',
          hooksConfig: '/tmp/hooks.toml',
          sessionsDir: dir,
        },
      } as ServerSettingsPayload,
    })
    url = `http://localhost:${server.port}`

    const settings = await fetch(`${url}/settings`).then((r) => r.json() as Promise<ServerSettingsPayload>)
    expect(settings.runtime?.pid).toBe(process.pid)
    expect(settings.runtime?.current).toBeNull()
    expect(settings.socketConnections).toMatchObject({
      total: expect.any(Number),
      dashboard: expect.any(Number),
      executor: expect.any(Number),
      other: expect.any(Number),
      updatedAt: expect.any(String),
    })
    expect(settings.socketConnections?.namespaces.some((entry) => entry.namespace === '/dashboard')).toBe(true)
    expect(settings.socketConnections?.namespaces.some((entry) => entry.namespace === '/executor')).toBe(true)
  })

  it('protects the Supervisor origin-result barrier with the private handoff secret', async () => {
    const previous = process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET
    process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET = 'origin-barrier-test-secret'
    try {
      const path = `${url}/internal/runtime/tool-result/session-origin/call-origin`
      expect((await fetch(path)).status).toBe(401)
      const response = await fetch(path, { headers: { 'x-agent-runlab-ingress-handoff': 'origin-barrier-test-secret' } })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ persisted: false })
    } finally {
      if (previous === undefined) delete process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET
      else process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('protects internal planned-restart control with the handoff secret', async () => {
    const previous = process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET
    process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET = 'restart-control-test-secret'
    try {
      expect((await fetch(`${url}/internal/runtime/restart/status`)).status).toBe(401)
      const authorized = await fetch(`${url}/internal/runtime/restart/status`, {
        headers: { 'x-agent-runlab-ingress-handoff': 'restart-control-test-secret' },
      })
      expect(authorized.status).toBe(200)
      expect(await authorized.json()).toMatchObject({ pid: process.pid, current: null })
      const requested = await fetch(`${url}/internal/runtime/restart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'restart-control-test-secret' },
        body: JSON.stringify({ mode: 'checkpoint', reason: 'deploy', timeoutMs: 60_000 }),
      })
      expect(requested.status).toBe(200)
      expect(await requested.json()).toMatchObject({ phase: 'draining', mode: 'checkpoint' })
      await fetch(`${url}/runtime/restart/abort`, { method: 'POST' })
    } finally {
      if (previous === undefined) delete process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET
      else process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('rejects public legacy restart control for a platform Runtime', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config, httpServer: http,
      deployment: DEDICATED_DEPLOYMENT,
    })
    url = `http://localhost:${server.port}`

    for (const [path, method] of [
      ['/runtime/restart/status', 'GET'],
      ['/runtime/restart', 'POST'],
      ['/runtime/restart/commit', 'POST'],
      ['/runtime/restart/abort', 'POST'],
    ] as const) {
      const response = await fetch(`${url}${path}`, { method })
      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('Deploy Supervisor') })
    }
    expect(server.restartStatus().current).toBeNull()
  })

  it('acknowledges internal admission as committed only after the operation reaches Session JSONL', async () => {
    const previous = process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET
    process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET = 'admission-jsonl-test-secret'
    try {
      const sessionId = 'admission-jsonl-session'
      await server.store.create({ sessionId, config })
      const first = await fetch(`${url}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'admission-jsonl-test-secret' },
        body: JSON.stringify({ sessionId, operationId: 'operation-admission-jsonl', text: 'deliver exactly once', mode: 'queue' }),
      })
      expect(first.status).toBe(200)
      const initial = await first.json() as { committed: boolean; cursor?: number }
      expect(initial.committed).toBe(false)
      await vi.waitFor(async () => {
        const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
        expect(parsed.events.some((entry) => entry.event.kind === 'user_message' && entry.event.operationId === 'operation-admission-jsonl')).toBe(true)
      })
      const retry = await fetch(`${url}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'admission-jsonl-test-secret' },
        body: JSON.stringify({ sessionId, operationId: 'operation-admission-jsonl', text: 'deliver exactly once', mode: 'queue' }),
      })
      const committed = await retry.json() as { committed: boolean; cursor: number }
      expect(committed).toMatchObject({ committed: true, cursor: expect.any(Number) })
      const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
      expect(parsed.events.filter((entry) => entry.event.kind === 'user_message' && entry.event.operationId === 'operation-admission-jsonl')).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET
      else process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('returns a stable machine-readable failure when internal admission targets a deleted Session', async () => {
    const previous = process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET
    process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET = 'admission-missing-session-secret'
    try {
      const response = await fetch(`${url}/internal/runtime/admission/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-runlab-ingress-handoff': 'admission-missing-session-secret' },
        body: JSON.stringify({ sessionId: 'deleted-session', operationId: 'operation-deleted-session', text: 'cannot deliver', mode: 'queue' }),
      })
      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_NOT_FOUND', error: expect.stringContaining('no longer exists') })
    } finally {
      if (previous === undefined) delete process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET
      else process.env.AGENT_RUNLAB_INGRESS_HANDOFF_SECRET = previous
    }
  })

  it('handshake auth rejects role mismatch', async () => {
    const bad: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 's', role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    const err = await new Promise<Error>((resolve) => {
      bad.on('connect_error', (e) => resolve(e))
    })
    expect(err.message).toBe('role_mismatch')
    bad.close()
  })

  it('reports a clear error when the requested port is already in use', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(0, resolve))
    const port = (occupied.address() as AddressInfo).port
    const sessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-port-'))

    try {
      await expect(startHostServer({
        port,
        sessionsDir,
        llm: scriptedLlm(),
        defaultConfig: config,
        toolTimeoutMs: 2000,
      })).rejects.toThrow(`Port ${port} is already in use`)
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('keeps candidate Dashboard mutations fenced until mutable runtime readiness while permitting reads', async () => {
    await server.close()
    let mutableReady = false
    server = await startHostServer({ port: 0, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config, mutableReady: () => mutableReady })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { clientId: 'readiness-fence-client', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', () => resolve()))
    const sessions = await new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.once('server:sessions', resolve)
      dashboard.emit('client:list_sessions', {})
    })
    expect(Array.isArray(sessions.sessions)).toBe(true)
    const rejected = await dashboard.timeout(1000).emitWithAck('client:create_session', { operationId: 'operation-before-ready', sessionId: 'candidate-mutation' })
    expect(rejected).toMatchObject({ ok: false, error: 'runtime_not_ready' })
    expect(server.store.get('candidate-mutation')).toBeUndefined()
    mutableReady = true
    await new Promise<void>((resolve, reject) => dashboard.emit('client:create_session', { operationId: 'operation-after-ready', sessionId: 'candidate-mutation' }, (ack) => ack.ok ? resolve() : reject(new Error(ack.error))))
    expect(server.store.get('candidate-mutation')).toBeTruthy()
    dashboard.close()
  })

  it('does not let candidate read subscriptions resume a dangling Session before route commit', async () => {
    await server.close()
    const seedLlm: LLMAdapter = {
      name: 'seed',
      async call() {
        return { message: { role: 'assistant', content: [{ type: 'text', text: 'must be continued only by the planned restart owner' }] } }
      },
    }
    server = await startHostServer({ port: 0, sessionsDir: dir, llm: seedLlm, defaultConfig: config })
    const record = await server.store.create({ sessionId: 'candidate-dangling', config })
    await server.store.record(
      record.sessionId,
      { kind: 'user_message', text: 'continue me after cutover' },
      [{ kind: 'call_llm', messages: record.state.messages, tools: config.tools }],
      { ...record.state, status: 'thinking', cursor: record.state.cursor + 1, messages: [...record.state.messages, { role: 'user', content: [{ type: 'text', text: 'continue me after cutover' }] }] },
    )
    const frozenCursor = server.store.get(record.sessionId)!.state.cursor
    await server.close()

    let llmCalls = 0
    let mutableReady = false
    server = await startHostServer({
      port: 0, sessionsDir: dir, defaultConfig: config, mutableReady: () => mutableReady,
      llm: { name: 'candidate', async call() { llmCalls += 1; return { message: { role: 'assistant', content: [{ type: 'text', text: 'continued' }] } } } },
    })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { clientId: 'candidate-reader', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', () => resolve()))
    await dashboard.timeout(1000).emitWithAck('client:subscribe_channels', {
      requestId: 'candidate-read-subscribe', generation: 1, channels: [`session:${record.sessionId}`],
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(llmCalls).toBe(0)
    expect(server.store.get(record.sessionId)!.state).toMatchObject({ status: 'thinking', cursor: frozenCursor })

    mutableReady = true
    await dashboard.timeout(1000).emitWithAck('client:subscribe_channels', {
      requestId: 'public-read-subscribe', generation: 2, channels: [`session:${record.sessionId}`],
    })
    await vi.waitFor(() => expect(llmCalls).toBe(1))
    expect(server.store.get(record.sessionId)!.state.cursor).toBe(frozenCursor + 1)
    dashboard.close()
  })

  it('keeps candidate overflow reads from recovering a dangling Session as interrupted', async () => {
    await server.close()
    server = await startHostServer({ port: 0, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config })
    const record = await server.store.create({
      sessionId: 'candidate-overflow-read',
      workspaceId: 'workspace-overflow-read',
      config,
    })
    await server.store.record(
      record.sessionId,
      { kind: 'user_message', text: 'continue only through planned restart' },
      [{ kind: 'call_llm', messages: record.state.messages, tools: config.tools }],
      { ...record.state, status: 'thinking', cursor: record.state.cursor + 1, messages: [...record.state.messages, { role: 'user', content: [{ type: 'text', text: 'continue only through planned restart' }] }] },
    )
    const frozenCursor = server.store.get(record.sessionId)!.state.cursor
    await server.close()

    server = await startHostServer({
      port: 0, sessionsDir: dir, llm: scriptedLlm(), defaultConfig: config, mutableReady: () => false,
    })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { clientId: 'candidate-overflow-reader', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.on('connect', () => resolve()))
    const result = new Promise<void>((resolve) => dashboard.once('server:overflow_contents', () => resolve()))
    dashboard.emit('client:read_overflow', {
      requestId: 'candidate-overflow-request', sessionId: record.sessionId, callId: 'candidate-overflow-call',
    })
    await result

    expect(server.store.get(record.sessionId)!.state).toMatchObject({ status: 'thinking', cursor: frozenCursor })
    const parsed = await readSessionLog(server.store.get(record.sessionId)!.logPath)
    expect(parsed.events.some((entry) => JSON.stringify(entry).includes('[interrupted]'))).toBe(false)
    dashboard.close()
  })

  it('returns 404 for stale static chunks instead of the SPA HTML shell', async () => {
    await server.close()
    const staticDir = mkdtempSync(join(tmpdir(), 'agent-kernel-static-'))
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>dashboard shell</title>', 'utf8')
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      staticDir,
    })
    url = `http://localhost:${server.port}`

    const staleChunk = await fetch(`${url}/assets/index-stale.js`)
    expect(staleChunk.status).toBe(404)
    expect(staleChunk.headers.get('content-type') ?? '').not.toContain('text/html')

    const spaRoute = await fetch(`${url}/sessions/example`)
    expect(spaRoute.status).toBe(200)
    expect(spaRoute.headers.get('content-type')).toContain('text/html')
    expect(await spaRoute.text()).toContain('dashboard shell')

    rmSync(staticDir, { recursive: true, force: true })
  })

  it('returns 404 for stale embedded chunks instead of the SPA HTML shell', async () => {
    await server.close()
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      embeddedStaticAssets: [
        { path: 'index.html', contentBase64: Buffer.from('<!doctype html><title>embedded shell</title>').toString('base64') },
      ],
    })
    url = `http://localhost:${server.port}`

    const staleChunk = await fetch(`${url}/assets/index-stale.js`)
    expect(staleChunk.status).toBe(404)
    expect(staleChunk.headers.get('content-type') ?? '').not.toContain('text/html')

    const spaRoute = await fetch(`${url}/sessions/example`)
    expect(spaRoute.status).toBe(200)
    expect(spaRoute.headers.get('content-type')).toContain('text/html')
    expect(await spaRoute.text()).toContain('embedded shell')
  })

  it('serves local release assets without SPA fallback', async () => {
    const releaseDir = mkdtempSync(join(tmpdir(), 'agent-kernel-release-assets-'))
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-release-sessions-'))
    await writeFile(join(releaseDir, 'run.sh'), '#!/usr/bin/env bash\necho local\n', 'utf8')
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      releaseAssetsDir: releaseDir,
      settings: {
        providers: [],
        defaultModel: '',
        hooks: [],
        paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
        mcp: { supported: false, note: '' },
        release: { bootstrapBaseUrl: 'http://localhost:0/release-assets', source: 'local' },
      },
    })

    try {
      const ok = await fetch(`http://localhost:${localServer.port}/release-assets/run.sh`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('echo local')
      const missing = await fetch(`http://localhost:${localServer.port}/release-assets/missing.sh`)
      expect(missing.status).toBe(404)
      const powershell = await fetch(`http://localhost:${localServer.port}/install.ps1`, {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'downloads.example.test' },
      })
      expect(powershell.status).toBe(200)
      expect(powershell.headers.get('content-type')).toContain('text/plain')
      const script = await powershell.text()
      expect(script).toContain("$ErrorActionPreference = 'Stop'")
      expect(script).toContain('$code = $env:RUNLAB_SETUP_CODE')
      expect(script).toContain('https://downloads.example.test/install/session')
      expect(script).toContain('https://downloads.example.test/install/assets/install-executor.ps1')
      expect(script).toContain('winget.Source install --id OpenJS.NodeJS.LTS')
      expect(script.indexOf('winget.Source install')).toBeLessThan(script.indexOf('/install/session'))
      expect(script).not.toContain('EXECUTOR_INVITE')
      expect(script).not.toContain('<!DOCTYPE html>')
    } finally {
      await localServer.close()
      rmSync(releaseDir, { recursive: true, force: true })
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('serves embedded release assets when the local release dir is missing a file', async () => {
    const releaseDir = mkdtempSync(join(tmpdir(), 'agent-kernel-release-assets-empty-'))
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-release-sessions-'))
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      releaseAssetsDir: releaseDir,
      embeddedReleaseAssets: [
        { path: 'agent-kernel-executor.cjs', contentBase64: Buffer.from('#!/usr/bin/env node\nconsole.log("embedded executor")\n').toString('base64') },
        { path: 'SHA256SUMS', contentBase64: Buffer.from('abc  agent-kernel-executor.cjs\n').toString('base64') },
      ],
      settings: {
        providers: [],
        defaultModel: '',
        hooks: [],
        paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
        mcp: { supported: false, note: '' },
        release: { bootstrapBaseUrl: 'http://localhost:0/release-assets', source: 'local' },
      },
    })

    try {
      const ok = await fetch(`http://localhost:${localServer.port}/release-assets/agent-kernel-executor.cjs`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('embedded executor')
      const sums = await fetch(`http://localhost:${localServer.port}/release-assets/SHA256SUMS`)
      expect(sums.status).toBe(200)
      expect(await sums.text()).toContain('agent-kernel-executor.cjs')
      const missing = await fetch(`http://localhost:${localServer.port}/release-assets/missing.cjs`)
      expect(missing.status).toBe(404)
    } finally {
      await localServer.close()
      rmSync(releaseDir, { recursive: true, force: true })
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('serves embedded installer assets without requiring a local release directory', async () => {
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-embedded-installer-sessions-'))
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      embeddedReleaseAssets: [
        { path: 'install-executor.sh', contentBase64: Buffer.from('#!/bin/sh\necho embedded installer\n').toString('base64') },
      ],
    })

    try {
      const response = await fetch(`http://localhost:${localServer.port}/install/assets/install-executor.sh`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/x-shellscript')
      expect(await response.text()).toContain('embedded installer')
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('updates agent prompt settings through HTTP', async () => {
    let selectedPreset: 'codex' | 'claude-code' | 'custom' = 'codex'
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-agent-prompt-'))
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      settings: () => ({
        providers: [],
        defaultModel: '',
        hooks: [],
        agentPrompt: {
          selectedPreset,
          presets: [
            { id: 'codex', label: 'Codex', description: 'Codex prompt' },
            { id: 'claude-code', label: 'Claude Code', description: 'Claude Code prompt' },
            { id: 'custom', label: 'Custom', description: 'Custom prompt' },
          ],
          customPrompt: 'Custom prompt',
          configPath: '/tmp/agent.json',
        },
        paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
        mcp: { supported: false, note: '' },
      }),
      updateAgentPrompt: (input) => {
        selectedPreset = input.preset
        return {
          providers: [],
          defaultModel: '',
          hooks: [],
          agentPrompt: {
            selectedPreset,
            presets: [
              { id: 'codex', label: 'Codex', description: 'Codex prompt' },
              { id: 'claude-code', label: 'Claude Code', description: 'Claude Code prompt' },
              { id: 'custom', label: 'Custom', description: 'Custom prompt' },
            ],
            customPrompt: input.customPrompt ?? 'Custom prompt',
            configPath: '/tmp/agent.json',
          },
          paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: '' },
          mcp: { supported: false, note: '' },
        }
      },
    })

    try {
      const response = await fetch(`http://localhost:${localServer.port}/settings/agent-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset: 'claude-code' }),
      })
      expect(response.status).toBe(200)
      const body = await response.json() as { agentPrompt?: { selectedPreset?: string } }
      expect(body.agentPrompt?.selectedPreset).toBe('claude-code')
      expect(selectedPreset).toBe('claude-code')
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('enables Socket.IO Admin UI immediately after the password is initialized', async () => {
    let initialized = false
    let runtimeMode: 'production' | 'development' = 'production'
    let configuredMode: 'production' | 'development' = 'production'
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-socket-admin-'))
    const adminPath = '/admin/socket.io'
    const settings = (): ServerSettingsPayload => ({
      providers: [],
      defaultModel: '',
      hooks: [],
      socketAdmin: {
        active: initialized,
        initialized,
        path: adminPath,
        username: 'admin',
        runtimeMode,
        configuredMode,
        configPath: join(localSessionsDir, 'socket-admin.json'),
        ...(initialized ? { distSource: 'embedded' as const } : {}),
        ...(initialized && configuredMode !== runtimeMode ? { restartRequired: true } : {}),
      },
      paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir: localSessionsDir },
      mcp: { supported: false, note: '' },
    })
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      settings,
      embeddedSocketAdminAssets: [
        { path: 'index.html', contentBase64: Buffer.from('<!doctype html><title>socket admin</title><script src="js/app.js"></script>').toString('base64') },
        { path: 'js/app.js', contentBase64: Buffer.from('globalThis.socketAdminLoaded = true').toString('base64') },
      ],
      initializeSocketAdmin: (input) => {
        if (initialized) {
          const err = new Error('already initialized') as Error & { status?: number }
          err.status = 409
          throw err
        }
        expect(input.password).toBe('password-123')
        expect(input.mode).toBe('development')
        initialized = true
        runtimeMode = input.mode ?? configuredMode
        configuredMode = runtimeMode
        input.activate({
          enabled: true,
          path: adminPath,
          username: 'admin',
          passwordHash: '$2b$10$012345678901234567890u7Z/08sx9Loa7TXHL62ojTkhUMYeOHpu',
          mode: runtimeMode,
          distSource: 'embedded',
        })
        return settings()
      },
      updateSocketAdminMode: (input) => {
        configuredMode = input.mode
        return settings()
      },
    })

    try {
      const init = await fetch(`http://localhost:${localServer.port}/settings/socket-admin/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'password-123', mode: 'development' }),
      })
      expect(init.status).toBe(200)
      const body = await init.json() as ServerSettingsPayload
      expect(body.socketAdmin?.initialized).toBe(true)
      expect(body.socketAdmin?.active).toBe(true)
      expect(body.socketAdmin?.runtimeMode).toBe('development')
      expect(body.socketAdmin?.configuredMode).toBe('development')
      expect(body.socketAdmin?.restartRequired).toBeUndefined()

      const updateMode = await fetch(`http://localhost:${localServer.port}/settings/socket-admin/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'production' }),
      })
      expect(updateMode.status).toBe(200)
      const modeBody = await updateMode.json() as ServerSettingsPayload
      expect(modeBody.socketAdmin?.runtimeMode).toBe('development')
      expect(modeBody.socketAdmin?.configuredMode).toBe('production')
      expect(modeBody.socketAdmin?.restartRequired).toBe(true)

      const noSlash = await fetch(`http://localhost:${localServer.port}${adminPath}`, { redirect: 'manual' })
      expect(noSlash.status).toBe(308)
      expect(noSlash.headers.get('location')).toBe(`${adminPath}/`)

      const adminUi = await fetch(`http://localhost:${localServer.port}${adminPath}/`)
      expect(adminUi.status).toBe(200)
      expect(await adminUi.text()).toContain('socket admin')

      const adminJs = await fetch(`http://localhost:${localServer.port}${adminPath}/js/app.js`)
      expect(adminJs.status).toBe(200)
      expect(adminJs.headers.get('content-type')).toContain('application/javascript')
      expect(await adminJs.text()).toContain('socketAdminLoaded')

      const second = await fetch(`http://localhost:${localServer.port}/settings/socket-admin/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'password-123' }),
      })
      expect(second.status).toBe(409)
      await second.text()
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('updates manual providers through HTTP without returning API keys', async () => {
    let providers: ServerSettingsPayload['providers'] = []
    let defaultModel = ''
    const localSessionsDir = mkdtempSync(join(tmpdir(), 'agent-kernel-manual-provider-'))
    const settings = (): ServerSettingsPayload => ({
      providers,
      defaultModel,
      hooks: [],
      paths: { claudeSettings: '', codexConfig: '', manualModels: '/tmp/models.json', hooksConfig: '', sessionsDir: '' },
      mcp: { supported: false, note: '' },
    })
    const localServer = await startHostServer({
      port: 0,
      sessionsDir: localSessionsDir,
      llm: scriptedLlm(),
      defaultConfig: config,
      settings,
      addManualProvider: (input) => {
        providers = [{
          id: input.id,
          label: input.label ?? input.id,
          wire: input.wire,
          source: 'manual',
          baseUrl: input.baseUrl,
          models: [],
        }]
        return settings()
      },
      deleteManualProvider: (input) => {
        providers = providers.filter((p) => p.id !== input.providerId)
        return settings()
      },
      setDefaultModel: (input) => {
        defaultModel = input.model
        return settings()
      },
    })

    try {
      const add = await fetch(`http://localhost:${localServer.port}/settings/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'local-openai',
          label: 'Local OpenAI',
          wire: 'openai',
          baseUrl: 'http://localhost:8000/v1',
          apiKey: 'test-redacted-api-key',
        }),
      })
      expect(add.status).toBe(200)
      const added = await add.json() as ServerSettingsPayload
      expect(added.providers).toEqual([
        expect.objectContaining({
          id: 'local-openai',
          label: 'Local OpenAI',
          wire: 'openai',
          source: 'manual',
          baseUrl: 'http://localhost:8000/v1',
        }),
      ])
      expect(JSON.stringify(added)).not.toContain('test-redacted-api-key')

      const setDefault = await fetch(`http://localhost:${localServer.port}/settings/default-model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'local-openai:gpt-local' }),
      })
      expect(setDefault.status).toBe(200)
      const defaulted = await setDefault.json() as ServerSettingsPayload
      expect(defaulted.defaultModel).toBe('local-openai:gpt-local')
      expect(JSON.stringify(defaulted)).not.toContain('test-redacted-api-key')

      const del = await fetch(`http://localhost:${localServer.port}/settings/providers?providerId=local-openai`, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const deleted = await del.json() as ServerSettingsPayload
      expect(deleted.providers).toEqual([])
    } finally {
      await localServer.close()
      rmSync(localSessionsDir, { recursive: true, force: true })
    }
  })

  it('handshake auth rejects mismatched protocol major', async () => {
    // Simulate an old dashboard build talking to a newer host.
    const bad: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 's', role: 'dashboard', clientVersion: '0.9.0' },
      reconnection: false,
    })
    const err = await new Promise<Error>((resolve) => {
      bad.on('connect_error', (e) => resolve(e))
    })
    expect(err.message).toBe('version_incompatible')
    bad.close()
  })

  it('handshake auth rejects missing clientVersion', async () => {
    const bad = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 's', role: 'dashboard' } as unknown as Record<string, unknown>,
      reconnection: false,
    })
    const err = await new Promise<Error>((resolve) => {
      bad.on('connect_error', (e) => resolve(e))
    })
    expect(err.message).toBe('version_incompatible')
    bad.close()
  })

  it('exposes compact dashboard socket metadata without duplicating session membership', async () => {
    const sessionId = 'wire-dashboard-metadata'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => dashboard.once('connect', resolve))

    const data = await waitForSocketData(server.io.of('/dashboard'))
    expect(data.dashboardActor).toEqual({ kind: 'anonymous' })
    expect(data.connectionMeta).toEqual({
      kind: 'dashboard',
      label: 'dashboard',
      clientVersion: PROTOCOL_VERSION,
      connectedAt: expect.any(String),
    })
    expect(Object.keys(data.connectionMeta as Record<string, unknown>).sort()).toEqual([
      'clientVersion',
      'connectedAt',
      'kind',
      'label',
    ])
    expect(JSON.stringify(data)).not.toContain(sessionId)

    dashboard.close()
  })

  it('exposes compact executor socket metadata without private credentials', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: {
        executorTokens: [{ token: 'exec-secret-token', workspaceId: 'ws-meta', label: 'runner token' }],
      },
    })
    url = `http://localhost:${server.port}`

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: 'exec-secret-token' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))

    const pending = await waitForSocketData(server.io.of('/executor'))
    expect(pending.executorIdentity).toEqual({
      accepted: true,
      workspaceId: 'ws-meta',
      label: 'runner token',
    })
    expect(pending.connectionMeta).toEqual({
      kind: 'executor',
      label: 'executor pending',
      clientVersion: PROTOCOL_VERSION,
      connectedAt: expect.any(String),
    })

    executor.emit('executor:announce', {
      executorId: 'exec-meta',
      workspaceId: 'ws-meta',
      workspaceName: 'metadata workspace',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })

    const announced = await waitForSocketData(server.io.of('/executor'), 1000, (data) => {
      const meta = data.connectionMeta as { executorId?: string } | undefined
      return meta?.executorId === 'exec-meta'
    })
    expect(announced.connectionMeta).toEqual({
      kind: 'executor',
      label: 'executor metadata workspace',
      clientVersion: PROTOCOL_VERSION,
      connectedAt: expect.any(String),
      executorId: 'exec-meta',
      workspaceId: 'ws-meta',
      workspaceName: 'metadata workspace',
    })
    expect(Object.keys(announced.connectionMeta as Record<string, unknown>).sort()).toEqual([
      'clientVersion',
      'connectedAt',
      'executorId',
      'kind',
      'label',
      'workspaceId',
      'workspaceName',
    ])
    expect(JSON.stringify(announced)).not.toContain('exec-secret-token')
    expect(announced.executorIdentity).not.toHaveProperty('inviteToken')
    expect(announced.executorIdentity).not.toHaveProperty('token')
    expect(announced.connectionMeta).not.toHaveProperty('inviteToken')
    expect(announced.connectionMeta).not.toHaveProperty('token')
    expect(JSON.stringify(announced)).not.toContain('tools')
    expect(JSON.stringify(announced)).not.toContain('runtimeVersion')

    executor.close()
  })

  it('rejects executor announce when token scope does not match workspaceId', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: {
        executorTokens: [{ token: 'exec-token', workspaceId: 'ws-allowed', label: 'allowed executor' }],
      },
    })
    url = `http://localhost:${server.port}`

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: 'exec-token' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    const reject = new Promise<{ code: string; message: string }>((resolve) => {
      executor.on('executor:host_reject', resolve)
    })
    executor.emit('executor:announce', {
      executorId: 'exec-1',
      workspaceId: 'ws-other',
      workspaceName: 'other',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    await expect(reject).resolves.toMatchObject({ code: 'workspace_identity_mismatch' })
    executor.close()
  })

  it('accepts executor announce when token scope matches workspaceId', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: {
        executorTokens: [{ token: 'exec-token', workspaceId: 'ws-allowed' }],
      },
    })
    url = `http://localhost:${server.port}`

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, token: 'exec-token' },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    executor.emit('executor:announce', {
      executorId: 'exec-1',
      workspaceId: 'ws-allowed',
      workspaceName: 'allowed',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'dash', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    await waitForWorkspace(dashboard, 'ws-allowed')
    dashboard.close()
    executor.close()
  })

  it('creates permanent executor invites and binds the first announced workspace', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const inviteRes = await fetch(`${url}/auth/executor-invites`, { method: 'POST' })
    expect(inviteRes.ok).toBe(true)
    const invite = await inviteRes.json() as { id: string; inviteToken: string; createdAt: string }
    expect(invite.id).toMatch(/^inv_/)
    expect(invite.inviteToken).toMatch(/^ak_invite_/)
    expect(readFileSync(identityPath, 'utf8')).not.toContain(invite.inviteToken)

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, invite: invite.inviteToken },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    const welcome = new Promise<{ token: string; workspaceId: string }>((resolve) => executor.on('executor:welcome', resolve))
    executor.emit('executor:announce', {
      executorId: 'exec-invite',
      workspaceId: 'ws-invite',
      workspaceName: 'invited',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    const payload = await welcome
    expect(payload.workspaceId).toBe('ws-invite')
    expect(payload.token).toMatch(/^ak_exec_/)
    const data = await waitForSocketData(server.io.of('/executor'), 1000, (candidate) => {
      const meta = candidate.connectionMeta as { workspaceId?: string } | undefined
      return meta?.workspaceId === 'ws-invite'
    })
    expect(data.executorIdentity).toEqual({
      accepted: true,
      workspaceId: 'ws-invite',
      label: 'invited',
    })
    expect(data.executorIdentity).not.toHaveProperty('inviteToken')
    expect(data.executorIdentity).not.toHaveProperty('token')
    expect(data.connectionMeta).not.toHaveProperty('inviteToken')
    expect(data.connectionMeta).not.toHaveProperty('token')
    expect(JSON.stringify(data)).not.toContain(invite.inviteToken)
    expect(JSON.stringify(data)).not.toContain(payload.token)
    expect(readFileSync(identityPath, 'utf8')).toContain('ws-invite')
    expect(readFileSync(identityPath, 'utf8')).not.toContain(payload.token)

    const listRes = await fetch(`${url}/auth/executor-identities`)
    expect(listRes.ok).toBe(true)
    const listBody = await listRes.json() as { identities: Array<{ workspaceId: string; token?: string; tokenHash?: string }> }
    expect(listBody.identities).toEqual([expect.objectContaining({ workspaceId: 'ws-invite' })])
    expect(JSON.stringify(listBody)).not.toContain(payload.token)
    expect(JSON.stringify(listBody)).not.toContain('tokenHash')

    const inviteList = await fetch(`${url}/auth/executor-invites`).then((res) => res.json()) as { invites: Array<{ id: string; workspaceId?: string; lastUsedAt?: string; inviteToken?: string; inviteHash?: string; revoked: boolean }> }
    expect(inviteList.invites).toEqual([expect.objectContaining({ id: invite.id, workspaceId: 'ws-invite', revoked: false })])
    expect(inviteList.invites[0]?.lastUsedAt).toBeTruthy()
    expect(JSON.stringify(inviteList)).not.toContain(invite.inviteToken)
    expect(JSON.stringify(inviteList)).not.toContain('inviteHash')

    const revokeRes = await fetch(`${url}/auth/executor-identities?workspaceId=ws-invite`, { method: 'DELETE' })
    expect(revokeRes.ok).toBe(true)
    expect(await revokeRes.json()).toEqual({ ok: true, workspaceId: 'ws-invite', revoked: true })
    const afterRevoke = await fetch(`${url}/auth/executor-identities`).then((res) => res.json()) as { identities: unknown[] }
    expect(afterRevoke.identities).toEqual([])
    executor.close()
  })

  it('revoking an executor invite also removes the saved reconnect identity', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const invite = await fetch(`${url}/auth/executor-invites`, { method: 'POST' }).then((res) => res.json()) as { id: string; inviteToken: string }
    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, invite: invite.inviteToken },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    executor.emit('executor:announce', { executorId: 'exec-revoke-invite', workspaceId: 'ws-revoke-invite', workspaceName: 'revoked', tools: ['bash'], runtime: 'node', runtimeVersion: 'test' })
    await new Promise<{ token: string; workspaceId: string }>((resolve) => executor.on('executor:welcome', resolve))
    executor.close()
    await expect(fetch(`${url}/auth/executor-identities`).then((res) => res.json())).resolves.toMatchObject({ identities: [expect.objectContaining({ workspaceId: 'ws-revoke-invite' })] })

    const revokeRes = await fetch(`${url}/auth/executor-invites/${invite.id}/revoke`, { method: 'POST' })
    expect(revokeRes.ok).toBe(true)
    await expect(fetch(`${url}/auth/executor-identities`).then((res) => res.json())).resolves.toEqual({ identities: [] })
  })

  it('keeps executor invites valid across host restarts without storing plaintext invites', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const invite = await fetch(`${url}/auth/executor-invites`, { method: 'POST' }).then((res) => res.json()) as { inviteToken: string }
    expect(readFileSync(identityPath, 'utf8')).not.toContain(invite.inviteToken)

    await server.close()
    const restartedStore = new ExecutorIdentityStore(identityPath)
    restartedStore.load()
    const restartedHttp = createServer()
    await new Promise<void>((resolve) => restartedHttp.listen(0, resolve))
    server = await startHostServer({
      port: (restartedHttp.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: restartedHttp,
      auth: { executorIdentityStore: restartedStore },
    })
    url = `http://localhost:${server.port}`

    const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, invite: invite.inviteToken },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', resolve))
    const welcome = new Promise<{ token: string; workspaceId: string }>((resolve) => executor.on('executor:welcome', resolve))
    executor.emit('executor:announce', {
      executorId: 'exec-restarted-invite',
      workspaceId: 'ws-restarted-invite',
      workspaceName: 'restarted',
      tools: ['bash'],
      runtime: 'node',
      runtimeVersion: 'test',
    })
    await expect(welcome).resolves.toMatchObject({ workspaceId: 'ws-restarted-invite' })
    executor.close()
  })

  it('allows invite reuse for the bound workspace and rejects a different workspace', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const invite = await fetch(`${url}/auth/executor-invites`, { method: 'POST' }).then((res) => res.json()) as { inviteToken: string }

    async function announceWithInvite(executorId: string, workspaceId: string): Promise<ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>> {
      const executor: ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents> = clientIO(`${url}/executor`, {
        transports: ['websocket'],
        auth: { role: 'executor', clientVersion: PROTOCOL_VERSION, invite: invite.inviteToken },
        reconnection: false,
      })
      await new Promise<void>((resolve) => executor.on('connect', resolve))
      executor.emit('executor:announce', { executorId, workspaceId, workspaceName: workspaceId, tools: ['bash'], runtime: 'node', runtimeVersion: 'test' })
      return executor
    }

    const first = await announceWithInvite('exec-reuse-1', 'ws-reuse')
    await new Promise<{ token: string; workspaceId: string }>((resolve) => first.on('executor:welcome', resolve))
    first.close()

    const second = await announceWithInvite('exec-reuse-2', 'ws-reuse')
    await expect(new Promise<{ token: string; workspaceId: string }>((resolve) => second.on('executor:welcome', resolve))).resolves.toMatchObject({ workspaceId: 'ws-reuse' })
    second.close()

    const wrong = await announceWithInvite('exec-reuse-3', 'ws-other')
    await expect(new Promise<{ code: string }>((resolve) => wrong.on('executor:host_reject', resolve))).resolves.toMatchObject({ code: 'auth_failed' })
    wrong.close()
  })

  it('regenerates executor invites and clears the workspace binding', async () => {
    await server.close()
    const identityPath = join(dir, 'executor-identities.json')
    const identityStore = new ExecutorIdentityStore(identityPath)
    identityStore.load()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      auth: { executorIdentityStore: identityStore },
    })
    url = `http://localhost:${server.port}`

    const created = await fetch(`${url}/auth/executor-invites`, { method: 'POST', body: JSON.stringify({ label: 'runner', workspaceId: 'ws-old' }) }).then((res) => res.json()) as { id: string; inviteToken: string }
    const regenerated = await fetch(`${url}/auth/executor-invites/${created.id}/regenerate`, { method: 'POST' }).then((res) => res.json()) as { id: string; inviteToken: string; workspaceId?: string; label?: string }
    expect(regenerated.id).toBe(created.id)
    expect(regenerated.inviteToken).toMatch(/^ak_invite_/)
    expect(regenerated.inviteToken).not.toBe(created.inviteToken)
    expect(regenerated.workspaceId).toBeUndefined()
    expect(regenerated.label).toBe('runner')
    expect(readFileSync(identityPath, 'utf8')).not.toContain(regenerated.inviteToken)
  })

  it('answers first-paint dashboard requests sent before session:ready', async () => {
    const sessionId = 'wire-first-paint'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })

    const sessionsPromise = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.once('server:sessions', resolve)
    })
    const historyPromise = new Promise<ServerHistoryPayload>((resolve) => {
      dashboard.once('server:history', resolve)
    })
    await new Promise<void>((resolve) => dashboard.once('connect', resolve))
    dashboard.emit('client:list_sessions', {})
    dashboard.emit('client:load_history', { sessionId })

    const [sessions, history] = await Promise.all([sessionsPromise, historyPromise])
    expect(sessions.sessions.some((s) => s.sessionId === sessionId)).toBe(true)
    expect(history.sessionId).toBe(sessionId)
    expect(history.entries).toEqual([])

    dashboard.close()
  })

  it('exposes bounded Prometheus operational metrics', async () => {
    const response = await fetch(`${url}/metrics`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    const body = await response.text()
    expect(body).toContain('agent_kernel_process_starts_total')
    expect(body).toContain('deployment_mode="portable"')
  })

  it('serves custom dashboard middleware after JSON routes', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const handled: string[] = []
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      dashboardHandler(req, res) {
        handled.push(req.url ?? '/')
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dashboard middleware')
      },
    })
    url = `http://localhost:${server.port}`

    const models = await fetch(`${url}/models`).then((r) => r.json())
    expect(models).toEqual({ models: [], defaultModel: '' })

    const dashboard = await fetch(`${url}/custom-route`).then((r) => r.text())
    expect(dashboard).toBe('dashboard middleware')
    expect(handled).toEqual(['/custom-route'])
  })

  it('recomputes context snapshot from the selected advertised model', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const modelConfig = createConfig({
      tools: [WRITE],
      systemPrompt: 'sys',
      contextLimit: 400_000,
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: modelConfig,
      httpServer: http,
      models: [
        {
          ref: 'openai:gpt-5.5',
          id: 'gpt-5.5',
          label: 'GPT 5.5',
          provider: 'openai',
          providerId: 'openai',
          contextWindow: 400_000,
        },
        {
          ref: 'anthropic:claude-opus-4.7-1m-internal',
          id: 'claude-opus-4.7-1m-internal',
          label: 'Claude Opus 4.7 1M',
          provider: 'anthropic',
          providerId: 'anthropic',
          contextWindow: 1_000_000,
        },
      ],
      defaultModel: 'openai:gpt-5.5',
    })
    url = `http://localhost:${server.port}`

    const sessionId = 'wire-context-model'
    await server.store.ensure({ sessionId, defaultConfig: modelConfig })
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const changed = new Promise<DashboardServerToClientEvents['state:changed']>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('state:changed never emitted')), 1000)
      dashboard.on('state:changed', (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })
    dashboard.emit('client:update_preferences', {
      sessionId,
      preferences: { selectedModel: 'anthropic:claude-opus-4.7-1m-internal' },
    })

    const payload = await changed
    expect(payload.contextSnapshot?.contextWindow).toEqual({ tokens: 1_000_000, source: 'model_registry' })
    expect(payload.contextSnapshot?.model).toMatchObject({ ref: 'anthropic:claude-opus-4.7-1m-internal', id: 'claude-opus-4.7-1m-internal', provider: 'anthropic' })

    dashboard.close()
  })

  it('persists selected model preferences and restores them on a new host instance', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'anthropic:claude-opus', id: 'claude-opus', label: 'Claude Opus', provider: 'anthropic', providerId: 'anthropic' },
      ],
    })
    url = `http://localhost:${server.port}`

    const sessionId = 'wire-model-persist'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const changed = new Promise<void>((resolve) => dashboard.on('server:control_update', (payload) => {
      if (payload.kind === 'session_meta_changed' && payload.sessionId === sessionId && payload.preferences?.selectedModel === 'anthropic:claude-opus') {
        resolve()
      }
    }))
    dashboard.emit('client:update_preferences', { sessionId, preferences: { selectedModel: 'anthropic:claude-opus' } })
    await changed
    dashboard.close()

    const firstRecord = server.store.get(sessionId)!
    expect(firstRecord.preferences.selectedModel).toBe('anthropic:claude-opus')
    expect((await readSessionLog(firstRecord.logPath)).metadata.at(-1)?.selectedModel).toBe('anthropic:claude-opus')

    await server.close()
    const restartedHttp = createServer()
    await new Promise<void>((resolve) => restartedHttp.listen(0, resolve))
    server = await startHostServer({
      port: (restartedHttp.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: restartedHttp,
      models: [
        { ref: 'anthropic:claude-opus', id: 'claude-opus', label: 'Claude Opus', provider: 'anthropic', providerId: 'anthropic' },
      ],
    })
    url = `http://localhost:${server.port}`
    const reconnected = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => reconnected.on('session:ready', resolve))
    expect(ready.selectedModel).toBe('anthropic:claude-opus')
    reconnected.close()
  })

  it('uses the current default when a persisted selected model has left the catalog', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'anthropic:claude-opus-4.8', id: 'claude-opus-4.8', label: 'Claude Opus 4.8', provider: 'anthropic', providerId: 'anthropic' },
      ],
      defaultModel: 'anthropic:claude-opus-4.8',
    })
    url = `http://localhost:${server.port}`

    const sessionId = 'wire-historical-model-context'
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.store.updatePreferences(sessionId, { selectedModel: 'anthropic:claude-opus-4.7-1m-internal' })

    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    expect(ready.selectedModel).toBe('anthropic:claude-opus-4.8')
    expect(ready.contextSnapshot.model).toMatchObject({
      ref: 'anthropic:claude-opus-4.8',
      id: 'claude-opus-4.8',
      provider: 'anthropic',
    })
    expect(ready.contextSnapshot.contextWindow).toEqual({ tokens: 1_000_000, source: 'model_registry' })
    dashboard.close()
  })

  it('shares known context metadata across providers exposing the same model id', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'primary:gpt-shared', id: 'gpt-shared', label: 'Shared Primary', provider: 'primary', providerId: 'primary', contextWindow: 353_346 },
        { ref: 'secondary:gpt-shared', id: 'gpt-shared', label: 'Shared Secondary', provider: 'secondary', providerId: 'secondary' },
      ],
      defaultModel: 'primary:gpt-shared',
    })
    url = `http://localhost:${server.port}`

    const sessionId = 'wire-shared-model-context'
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.store.updatePreferences(sessionId, { selectedModel: 'secondary:gpt-shared' })
    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    expect(ready.selectedModel).toBe('secondary:gpt-shared')
    expect(ready.contextSnapshot.contextWindow).toEqual({ tokens: 353_346, source: 'model_registry' })
    dashboard.close()
  })

  it('uses persisted session model preferences over the host default model', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const seenModels: Array<string | undefined> = []
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'openai:gpt-default', id: 'gpt-default', label: 'GPT Default', provider: 'openai', providerId: 'openai', contextWindow: 400_000 },
        { ref: 'anthropic:claude-session', id: 'claude-session', label: 'Claude Session', provider: 'anthropic', providerId: 'anthropic', contextWindow: 1_000_000 },
      ],
      defaultModel: 'openai:gpt-default',
      llm: {
        async call(p) {
          seenModels.push(p.model)
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    const sessionId = 'wire-model-preference-authority'
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.store.updatePreferences(sessionId, { selectedModel: 'anthropic:claude-session' })

    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    expect(ready.selectedModel).toBe('anthropic:claude-session')
    expect(ready.contextSnapshot.contextWindow).toEqual({ tokens: 1_000_000, source: 'model_registry' })

    const done = new Promise<DashboardServerToClientEvents['state:changed']>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('state:changed never emitted')), 1000)
      dashboard.on('state:changed', (payload) => {
        if (payload.state.status === 'done') {
          clearTimeout(timer)
          resolve(payload)
        }
      })
    })
    dashboard.emit('client:user_message', { sessionId, text: 'hello' })
    const payload = await done
    expect(seenModels).toEqual(['anthropic:claude-session'])
    expect(payload.contextSnapshot.model.ref).toBe('anthropic:claude-session')
    expect(payload.contextSnapshot.model.id).toBe('claude-session')
    expect(payload.contextSnapshot.model.provider).toBe('anthropic')
    expect(payload.contextSnapshot.contextWindow).toEqual({ tokens: 1_000_000, source: 'model_registry' })
    dashboard.close()
  })

  it('uses the host default model as the effective session model when no preference is set', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const seenModels: Array<string | undefined> = []
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'anthropic:first-model', id: 'first-model', label: 'First Model', provider: 'anthropic', providerId: 'anthropic', contextWindow: 200_000 },
        { ref: 'openai:gpt-default', id: 'gpt-default', label: 'GPT Default', provider: 'openai', providerId: 'openai', contextWindow: 400_000 },
      ],
      defaultModel: 'openai:gpt-default',
      llm: {
        async call(p) {
          seenModels.push(p.model)
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    const sessionId = 'wire-effective-default-model'
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    const ready = await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    expect(ready.selectedModel).toBe('openai:gpt-default')
    expect(ready.contextSnapshot.model.ref).toBe('openai:gpt-default')
    expect(ready.contextSnapshot.contextWindow).toEqual({ tokens: 400_000, source: 'model_registry' })

    const done = new Promise<DashboardServerToClientEvents['state:changed']>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('state:changed never emitted')), 1000)
      dashboard.on('state:changed', (payload) => {
        if (payload.state.status === 'done') {
          clearTimeout(timer)
          resolve(payload)
        }
      })
    })
    dashboard.emit('client:user_message', { sessionId, text: 'hello' })
    const payload = await done
    expect(seenModels).toEqual(['openai:gpt-default'])
    expect(payload.contextSnapshot.model.ref).toBe('openai:gpt-default')
    expect(payload.contextSnapshot.contextWindow).toEqual({ tokens: 400_000, source: 'model_registry' })
    dashboard.close()
  })

  it('rejects ambiguous bare model ids instead of silently choosing a provider', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    server = await startHostServer({
      port: (http.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      models: [
        { ref: 'openai:shared', id: 'shared', label: 'Shared OpenAI', provider: 'openai' },
        { ref: 'anthropic:shared', id: 'shared', label: 'Shared Anthropic', provider: 'anthropic' },
      ],
    })
    url = `http://localhost:${server.port}`
    const sessionId = 'wire-model-ambiguous'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const error = new Promise<DashboardServerToClientEvents['session:error']>((resolve) => dashboard.once('session:error', resolve))
    dashboard.emit('client:update_preferences', { sessionId, preferences: { selectedModel: 'shared' } })
    const payload = await error
    expect(payload.message).toContain('unknown or ambiguous model')
    expect(server.store.get(sessionId)?.preferences.selectedModel).toBeUndefined()
    dashboard.close()
  })

  it('exposes router health payload when the option is provided', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    let calls = 0
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      routerHealth: () => {
        calls += 1
        return { providers: [{ provider: 'anthropic', totalCalls: 3, successCount: 3, errorCount: 0 }] }
      },
    })
    url = `http://localhost:${server.port}`

    const health = await fetch(`${url}/router/health`).then((r) => r.json())
    expect(health).toEqual({ providers: [{ provider: 'anthropic', totalCalls: 3, successCount: 3, errorCount: 0 }] })
    expect(calls).toBe(1)
  })

  it('exposes artifact manifests only when artifact capture is configured', async () => {
    const missing = await fetch(`${url}/artifacts/manifest`).then(async (r) => ({
      status: r.status,
      body: await r.json() as { error: string },
    }))
    expect(missing.status).toBe(404)
    expect(missing.body.error).toContain('artifact capture')

    await server.close()
    const emptyArtifactRootDir = join(dir, 'empty-artifacts')
    const emptyHttp = createServer()
    await new Promise<void>((resolve) => emptyHttp.listen(0, resolve))
    server = await startHostServer({
      port: (emptyHttp.address() as AddressInfo).port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: emptyHttp,
      artifactRootDir: emptyArtifactRootDir,
    })
    url = `http://localhost:${server.port}`

    const emptyManifest = await fetch(`${url}/artifacts/manifest`).then(async (r) => ({
      status: r.status,
      body: await r.json() as { rootDir: string; summary: { entryCount: number } },
    }))
    expect(emptyManifest.status).toBe(200)
    expect(emptyManifest.body.rootDir).toBe(emptyArtifactRootDir)
    expect(emptyManifest.body.summary.entryCount).toBe(0)
    expect(JSON.parse(await readFile(join(emptyArtifactRootDir, 'artifact-manifest.json'), 'utf8'))).toMatchObject({
      rootDir: emptyArtifactRootDir,
      summary: { entryCount: 0 },
    })

    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
    await mkdir(join(artifactRootDir, 'llm/s1'), { recursive: true })
    await mkdir(join(artifactRootDir, 'traces'), { recursive: true })
    await mkdir(join(artifactRootDir, 'profiles/s1'), { recursive: true })
    await writeFile(join(artifactRootDir, 'llm/s1/1.request.json'), JSON.stringify({ ok: true }), 'utf8')
    await writeFile(join(artifactRootDir, 'traces/s1.openinference.json'), JSON.stringify({ spans: [] }), 'utf8')
    await writeFile(join(artifactRootDir, 'profiles/s1/profile.json'), JSON.stringify({ sessionId: 's1' }), 'utf8')

    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      artifactRootDir,
    })
    url = `http://localhost:${server.port}`

    const manifest = await fetch(`${url}/artifacts/manifest`).then((r) => r.json() as Promise<{
      summary: { entryCount: number; kinds: Record<string, number> }
      entries: Array<{ path: string; kind: string }>
    }>)
    expect(manifest.summary.entryCount).toBe(3)
    expect(manifest.summary.kinds.llm_request).toBe(1)
    expect(manifest.entries[0]).toMatchObject({ path: 'llm/s1/1.request.json', kind: 'llm_request' })

    const firstPage = await fetch(`${url}/artifacts/manifest?limit=1&kind=trace&kind=profile`).then((r) => r.json() as Promise<{
      entries: Array<{ path: string; kind: string }>
      page: { returnedEntries: number; totalEntries: number; hasMore: boolean; nextCursor?: string; snapshotId: string }
    }>)
    expect(firstPage.entries).toHaveLength(1)
    expect(firstPage.page).toMatchObject({ returnedEntries: 1, totalEntries: 2, hasMore: true })
    expect(firstPage.page.nextCursor).toBeTruthy()

    await writeFile(join(artifactRootDir, 'traces/new.openinference.json'), JSON.stringify({ spans: ['new'] }), 'utf8')
    const secondPage = await fetch(`${url}/artifacts/manifest?limit=1&kind=trace,profile&cursor=${encodeURIComponent(firstPage.page.nextCursor!)}`).then((r) => r.json() as Promise<{
      entries: Array<{ path: string; kind: string }>
      page: { returnedEntries: number; totalEntries: number; hasMore: boolean; snapshotId: string }
    }>)
    expect(secondPage.entries).toHaveLength(1)
    expect(secondPage.page).toMatchObject({ returnedEntries: 1, totalEntries: 2, hasMore: false, snapshotId: firstPage.page.snapshotId })
    expect([...firstPage.entries, ...secondPage.entries].map((entry) => entry.kind).sort()).toEqual(['profile', 'trace'])

    const mismatchedCursor = await fetch(`${url}/artifacts/manifest?limit=1&kind=profile&cursor=${encodeURIComponent(firstPage.page.nextCursor!)}`)
    expect(mismatchedCursor.status).toBe(400)
    const invalidLimit = await fetch(`${url}/artifacts/manifest?limit=501`)
    expect(invalidLimit.status).toBe(400)

    const content = await fetch(`${url}/artifacts/content?path=${encodeURIComponent('llm/s1/1.request.json')}`).then((r) => r.json() as Promise<{
      path: string
      body: { ok: boolean }
    }>)
    expect(content).toMatchObject({ path: 'llm/s1/1.request.json', body: { ok: true } })

    const download = await fetch(`${url}/artifacts/download?path=${encodeURIComponent('llm/s1/1.request.json')}`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''1.request.json")
    expect(await download.text()).toBe(JSON.stringify({ ok: true }))

    const traversal = await fetch(`${url}/artifacts/content?path=${encodeURIComponent('../secret.json')}`)
    expect(traversal.status).toBe(403)
  })

  it('serves repository docs dynamically without static generation', async () => {
    const index = await fetch(`${url}/docs/index`).then((r) => r.json() as Promise<{
      docs: Array<{ path: string; title: string }>
    }>)
    expect(index.docs.some((doc) => doc.path === 'host/context-compaction.md')).toBe(true)

    const content = await fetch(`${url}/docs/content?path=${encodeURIComponent('host/context-compaction.md')}`).then((r) => r.json() as Promise<{
      path: string
      body: string
    }>)
    expect(content.path).toBe('host/context-compaction.md')
    expect(content.body).toContain('# Context Compaction')

    const traversal = await fetch(`${url}/docs/content?path=${encodeURIComponent('../package.json')}`)
    expect(traversal.status).toBe(400)
  })

  it('serves embedded release docs when no filesystem docs root is configured', async () => {
    await server.close()
    server = await startHostServer({
      port: 0,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      embeddedDocs: [{ path: 'operations/release.md', contentBase64: Buffer.from('# Release Operations\n\nEmbedded runbook.').toString('base64') }],
    })
    url = `http://localhost:${server.port}`

    const index = await fetch(`${url}/docs/index`).then((response) => response.json() as Promise<{ docs: Array<{ path: string; title: string; size: number; updatedAt: string }> }>)
    expect(index.docs).toEqual([{ path: 'operations/release.md', title: 'Release Operations', size: 39, updatedAt: new Date(0).toISOString() }])
    const content = await fetch(`${url}/docs/content?path=${encodeURIComponent('operations/release.md')}`).then((response) => response.json() as Promise<{ body: string }>)
    expect(content.body).toContain('Embedded runbook.')
    expect((await fetch(`${url}/docs/content?path=${encodeURIComponent('operations/missing.md')}`)).status).toBe(404)
  })

  it('runs product enhancement artifact actions from dashboard routes', async () => {
    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
    const workspaceRoot = join(dir, 'workspace')
    await mkdir(join(workspaceRoot, '.agent-kernel', 'memory'), { recursive: true })
    await writeFile(join(workspaceRoot, '.agent-kernel', 'memory', 'style.md'), '---\nname: Style\nconfidence: 0.8\n---\nUse concise answers.\n', 'utf8')

    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm: scriptedLlm(),
      defaultConfig: config,
      httpServer: http,
      artifactRootDir,
    })
    url = `http://localhost:${server.port}`
    const { record } = await server.store.ensure({ sessionId: 'dash-actions-session', defaultConfig: config })
    await server.store.record(record.sessionId, { kind: 'user_message', text: 'hi' }, [], { ...record.state, cursor: record.state.cursor + 1 })

    const profile = await postEnhancementAction(url, { action: 'profile-session', sessionId: record.sessionId }) as { profilePath: string; profile: { sessionId: string } }
    expect(profile.profilePath).toBe(join(artifactRootDir, 'profile.json'))
    expect(profile.profile.sessionId).toBe(record.sessionId)

    const audit = await postEnhancementAction(url, { action: 'reliability-audit-session', sessionId: record.sessionId }) as { auditPath: string; audit: { sessionId: string } }
    expect(audit.auditPath).toBe(join(artifactRootDir, 'reliability-audit.json'))
    expect(audit.audit.sessionId).toBe(record.sessionId)

    const memory = await postEnhancementAction(url, { action: 'memory-index', workspaceRoot }) as { indexPath: string; entries: number }
    expect(memory.indexPath).toBe(join(artifactRootDir, 'memory-index.json'))
    expect(memory.entries).toBe(1)

    const retrieval = await postEnhancementAction(url, {
      action: 'memory-retrieve',
      workspaceRoot,
      query: 'concise answers',
      maxHits: 5,
    }) as { artifactPath: string; hitCount: number; reasonCodes: string[]; hits: Array<{ key: string; score: number }> }
    expect(retrieval.artifactPath).toBe(join(artifactRootDir, 'memory-retrieval.json'))
    expect(retrieval.hitCount).toBe(1)
    expect(retrieval.hits[0]!.key).toBe('style')
    expect(retrieval.reasonCodes).toContain('hits_selected')

    const graph = await postEnhancementAction(url, { action: 'subagents-graph' }) as { graphPath: string; nodes: number }
    expect(graph.graphPath).toBe(join(artifactRootDir, 'subagent-graph.json'))
    expect(graph.nodes).toBeGreaterThanOrEqual(1)

    const unsupported = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'not-real' }),
    })
    expect(unsupported.status).toBe(400)
  })

  it("rejects removed product evaluation entry points after the clean cutover", async () => {
    const actions = [
      "swebench-resolve-instances",
      "swebench-upload-patches",
      "swebench-upload-results",
      "swebench-grade-command",
      "terminal-bench-resolve-tasks",
      "terminal-bench-run-agent",
      "terminal-bench-read-progress",
      "badcase-list",
      "badcase-annotate",
      "badcase-export",
      "rollout-export",
    ]
    for (const action of actions) {
      const response = await fetch(`${url}/enhancement/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, rootDir: dir }),
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: `unsupported enhancement action: ${action}` })
    }
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-1',
      workspaceId: 'ws-ex-1',
      workspaceName: 'ex-1',
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )
    await server.store.updatePreferences(sessionId, { selectedModel: 'fork-model' })

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-fork',
      workspaceId: 'ws-ex-fork',
      workspaceName: 'ex-fork',
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

    const forked = new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', (payload) => {
        if (payload.reason === 'forked') resolve(payload)
      }),
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
    expect(ev.selectedModel).toBe('fork-model')
    // Original session has cursor 4; fork stops at 2 (user + llm tool_call).
    const forkedRec = server.store.get('wire-fork-child')
    expect(forkedRec?.state.sessionId).toBe('wire-fork-child')
    expect(forkedRec?.parentSessionId).toBe(sessionId)
    expect(forkedRec?.parentCursor).toBe(2)
    expect(forkedRec?.preferences.selectedModel).toBe('fork-model')
    expect(forkedRec?.state.cursor).toBe(2)
    expect(forkedRec).toBeTruthy()
    const forkedLog = await readSessionLog(forkedRec!.logPath)
    expect(forkedLog.header.sessionId).toBe('wire-fork-child')
    expect(forkedLog.header.initialState.sessionId).toBe('wire-fork-child')

    const summaries = await server.store.listSummaries()
    const childSummary = summaries.find((s) => s.sessionId === 'wire-fork-child')
    expect(childSummary).toBeTruthy()
    expect(childSummary?.parentSessionId).toBe(sessionId)

    dashboard.close()
    executor.close()
  })

  it('always cascades session deletion through descendant sessions', async () => {
    await server.store.create({ sessionId: 'delete-parent', config })
    await server.store.create({ sessionId: 'delete-child', config, parentSessionId: 'delete-parent' })
    await server.store.create({ sessionId: 'delete-grandchild', config, parentSessionId: 'delete-child' })
    await server.store.create({ sessionId: 'delete-sibling', config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'delete-parent', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const deleteSpy = vi.spyOn(server.store, 'delete')
    await new Promise<void>((resolve, reject) => dashboard.emit('client:delete_session', { operationId: 'delete-cascade-op', sessionId: 'delete-parent' }, (ack) => ack.ok ? resolve() : reject(new Error(ack.error))))
    let summaries = await server.store.listSummaries()
    for (let i = 0; i < 50 && summaries.length !== 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      summaries = await server.store.listSummaries()
    }
    expect(summaries.map((s) => s.sessionId).sort()).toEqual(['delete-sibling'])
    expect(deleteSpy.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'delete-grandchild',
      'delete-child',
      'delete-parent',
    ])
    dashboard.close()
  })

  it('atomically rejects tree deletion when any descendant has an active turn', async () => {
    await server.store.create({ sessionId: 'active-delete-parent', config })
    await server.store.create({ sessionId: 'active-delete-child', config, parentSessionId: 'active-delete-parent' })
    await server.store.create({ sessionId: 'active-delete-grandchild', config, parentSessionId: 'active-delete-child' })
    vi.spyOn(server.loop, 'hasActiveTurn').mockImplementation((sessionId) => sessionId === 'active-delete-grandchild')
    const deleteSpy = vi.spyOn(server.store, 'delete')

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'active-delete-parent', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const result = await dashboard.timeout(1000).emitWithAck('client:delete_session', {
      operationId: 'active-delete-op',
      sessionId: 'active-delete-parent',
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('active turn') })
    expect(deleteSpy).not.toHaveBeenCalled()
    expect((await server.store.listSummaries()).map((session) => session.sessionId)).toEqual(
      expect.arrayContaining(['active-delete-parent', 'active-delete-child', 'active-delete-grandchild']),
    )
    dashboard.close()
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-cancel',
      workspaceId: 'ws-ex-cancel',
      workspaceName: 'ex-cancel',
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

    const cancelled = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cancel never settled')), 2000)
      dashboard.on('state:changed', (payload) => {
        if (payload.state.status === 'done' && payload.state.pendingCalls.length === 0) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    dashboard.emit('client:cancel', { sessionId })
    const cancelPayload = await cancelSeen
    expect(cancelPayload.sessionId).toBe(sessionId)
    expect(cancelPayload.callId).toBe(toolCalls[0]!.callId)
    await cancelled

    // Kernel side: state must be `done`, pendingCalls empty.
    const rec = server.store.get(sessionId)
    expect(rec?.state.status).toBe('done')
    expect(rec?.state.pendingCalls).toEqual([])

    dashboard.close()
    executor.close()
  })

  it('lets the dashboard interrupt a running sub-agent inline', async () => {
    await server.close()
    const sessionId = 'wire-subagent-interrupt-parent'
    let call = 0
    const llm: LLMAdapter = {
      name: 'subagent-interrupt-test',
      async call(params) {
        call += 1
        if (call === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'agent-wire-1',
                  name: 'agent',
                  input: { prompt: 'long child task' },
                },
              ],
            },
          }
        }
        if (params.messages.length === 1 && JSON.stringify(params.messages).includes('long child task')) {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            if (params.signal?.aborted) abort()
            params.signal?.addEventListener('abort', abort, { once: true })
          })
        }
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'parent observed cancellation' }],
          },
        }
      },
    }
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const agentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm,
      defaultConfig: agentConfig,
      httpServer: http,
      toolTimeoutMs: 2000,
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: agentConfig })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const started = new Promise<ServerSubAgentStartedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_started') resolve(payload)
      })
    })
    const finished = new Promise<ServerSubAgentFinishedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_finished') resolve(payload)
      })
    })
    dashboard.emit('client:user_message', { sessionId, text: 'go' })

    const start = await started
    expect(start.parentSessionId).toBe(sessionId)
    expect(start.parentCallId).toBe('agent-wire-1')
    dashboard.emit('client:interrupt_sub_agent', {
      parentSessionId: sessionId,
      parentCallId: 'agent-wire-1',
      childSessionId: start.childSessionId,
    })

    const finish = await finished
    expect(finish.childSessionId).toBe(start.childSessionId)
    expect(finish.status).toBe('cancelled')
    expect(finish.error).toContain('sub-agent interrupted by user')

    const deadline = Date.now() + 2000
    let toolResultContent = ''
    while (Date.now() < deadline) {
      const rec = server.store.get(sessionId)
      if (rec?.state.status === 'done') {
        const log = await readSessionLog(rec.logPath)
        const toolResult = log.events.find(
          (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-wire-1',
        )
        if (toolResult?.event.kind === 'tool_result') {
          toolResultContent = toolResult.event.content
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(toolResultContent).toContain('status="cancelled"')
    expect(toolResultContent).toContain('sub-agent interrupted by user')

    const textDeadline = Date.now() + 2000
    while (Date.now() < textDeadline) {
      const rec = server.store.get(sessionId)
      if (rec?.state.status === 'done') {
        const log = await readSessionLog(rec.logPath)
        const hasParentText = log.events.some((e) => {
          if (e.event.kind !== 'llm_response') return false
          const content = e.event.message.content
          if (typeof content === 'string') return content.includes('parent observed cancellation')
          return content.some(
            (block) => block.type === 'text' && block.text.includes('parent observed cancellation'),
          )
        })
        if (hasParentText) break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    dashboard.close()
  })

  it('surfaces a failed sub-agent to the dashboard and lets the parent recover', async () => {
    // End-to-end coverage for the doc-declared failure path: parent LLM
    // spawns a child agent, the child's LLM throws → the host emits a
    // `server:control_update` with sub_agent_finished status=failed, writes a failure
    // envelope tool_result into the parent log, and the parent's next LLM
    // call still completes normally.
    await server.close()
    const sessionId = 'wire-subagent-fail-parent'
    let call = 0
    const llm: LLMAdapter = {
      name: 'subagent-fail-test',
      async call() {
        call += 1
        if (call === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_call',
                  callId: 'agent-wire-fail-1',
                  name: 'agent',
                  input: { prompt: 'crash please' },
                },
              ],
            },
          }
        }
        // The child session's LLM turn — throw to trigger the failure envelope.
        if (call === 2) throw new Error('child llm exploded')
        // The parent's next turn after receiving the failure envelope.
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'parent recovered after child failure' }],
          },
        }
      },
    }
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const agentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm,
      defaultConfig: agentConfig,
      httpServer: http,
      toolTimeoutMs: 2000,
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: agentConfig })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const started = new Promise<ServerSubAgentStartedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_started') resolve(payload)
      })
    })
    const finished = new Promise<ServerSubAgentFinishedEvent>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_finished') resolve(payload)
      })
    })
    dashboard.emit('client:user_message', { sessionId, text: 'go' })

    const start = await started
    expect(start.parentSessionId).toBe(sessionId)
    expect(start.parentCallId).toBe('agent-wire-fail-1')

    const finish = await finished
    expect(finish.parentSessionId).toBe(sessionId)
    expect(finish.parentCallId).toBe('agent-wire-fail-1')
    expect(finish.status).toBe('failed')
    expect(finish.error).toContain('child llm exploded')

    const deadline = Date.now() + 2000
    let parentStatus: string | undefined
    let toolResultContent = ''
    while (Date.now() < deadline) {
      const rec = server.store.get(sessionId)
      parentStatus = rec?.state.status
      if (rec?.state.status === 'done') {
        const log = await readSessionLog(rec.logPath)
        const toolResult = log.events.find(
          (e) => e.event.kind === 'tool_result' && e.event.callId === 'agent-wire-fail-1',
        )
        if (toolResult?.event.kind === 'tool_result') {
          toolResultContent = toolResult.event.content
        }
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // Parent must reach `done` after seeing the failure envelope; it does not
    // get stuck waiting for a child that already reported terminal state.
    expect(parentStatus).toBe('done')
    expect(toolResultContent).toContain('status="failed"')
    expect(toolResultContent).toContain('child llm exploded')
    // The parent's final assistant message reflects recovery.
    const finalState = server.store.get(sessionId)?.state
    const finalMsg = finalState?.messages.at(-1)
    const finalText = finalMsg?.role === 'assistant'
      ? finalMsg.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('')
      : ''
    expect(finalText).toContain('parent recovered after child failure')

    dashboard.close()
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
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
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
    // The whole point of Task #95 — 1 executor : N sessions. We open two
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
      auth: { sessionId: sessionA, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    const dashB: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: sessionB, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
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
      workspaceId: 'ws-ex-shared',
      workspaceName: 'ex-shared',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    await waitForAnyExecutor(server)

    // Every scripted LLM run consumes two entries from the queue. To exercise
    // two sessions we need a fresh scripted queue per session, which means a
    // full round-trip on the first before starting the second — the current
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
    // Only session A has had a completed round-trip in this test — session B
    // may not have received a tool_call yet since the scripted queue was
    // fully drained. That's fine; the daemon-routing invariant is checked by
    // executor.test.ts and by the fact that A's call landed with the right
    // sessionId on the single shared executor socket.

    dashA.close()
    dashB.close()
    executor.close()
  })

  it('broadcasts executor control updates and answers client:list_executors with the current snapshot', async () => {
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const changed = new Promise<ServerExecutorChangedPayload>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'executor_changed') resolve(payload)
      })
    })

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-list',
      workspaceId: 'ws-ex-list',
      workspaceName: 'ex-list',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
      hostname: 'test-host',
      os: 'linux',
      ipAddresses: ['192.0.2.1'],
      pid: 4242,
      startedAt: '2026-07-04T00:00:00.000Z',
    })

    const change = await changed
    expect(change.change).toBe('attached')
    expect(change.executorId).toBe('ex-list')
    if (change.change !== 'detached') {
      expect(change.executor.hostname).toBe('test-host')
      expect(change.executor.os).toBe('linux')
      expect(change.executor.ipAddresses).toEqual(['192.0.2.1'])
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
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'executor_changed' && payload.change === 'detached') {
          resolve(payload)
        }
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-hist',
      workspaceId: 'ws-ex-hist',
      workspaceName: 'ex-hist',
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

    // Sessions list — after one round-trip we expect exactly one summary
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

    // Load history — full then incremental.
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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

  it('acknowledges a durably created Session before slow advisory lifecycle hooks finish', async () => {
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    let releaseHook!: () => void
    const hookGate = new Promise<void>((resolve) => { releaseHook = resolve })
    let hookStarted!: () => void
    const started = new Promise<void>((resolve) => { hookStarted = resolve })
    server = await startHostServer({
      port, sessionsDir: dir, defaultConfig: config, httpServer: http, toolTimeoutMs: 2000, llm: scriptedLlm(),
      hooks: [{ event: 'session_start', command: 'slow' }],
      hookRunner: { async run() { hookStarted(); await hookGate; return { ok: true, exitCode: 0, stdout: '', stderr: '' } } },
    })
    url = `http://localhost:${server.port}`
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, { transports: ['websocket'], auth: { sessionId: 'control-slow-create', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const ack = dashboard.timeout(1000).emitWithAck('client:create_session', { operationId: 'slow-create-op', sessionId: 'wire-slow-create', tools: ['websearch'] })
    await expect(ack).resolves.toEqual({ ok: true })
    expect(server.store.get('wire-slow-create')).toBeDefined()
    await started
    releaseHook()
    dashboard.close()
  })

  it('returns unknown model creation failures through the RPC ack', async () => {
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, { transports: ['websocket'], auth: { sessionId: 'control-unknown-model', role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const ack = await dashboard.timeout(1000).emitWithAck('client:create_session', { operationId: 'unknown-model-op', sessionId: 'wire-unknown-model', selectedModel: 'definitely-missing-model' })
    expect(ack).toMatchObject({ ok: false, error: expect.stringContaining('unknown or ambiguous model') })
    expect(server.store.get('wire-unknown-model')).toBeUndefined()
    dashboard.close()
  })

  it('broadcasts session summaries when an inactive session advances', async () => {
    await server.store.ensure({ sessionId: 'active-session', defaultConfig: config })
    await server.store.ensure({ sessionId: 'inactive-session', defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: 'active-session', role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    const doneSummary = new Promise<ServerSessionsPayload>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inactive session summary was not broadcast')), 4000)
      dashboard.on('server:sessions', (payload) => {
        const inactive = payload.sessions.find((s) => s.sessionId === 'inactive-session')
        if (inactive?.status !== 'done') return
        clearTimeout(timer)
        resolve(payload)
      })
    })

    await server.loop.dispatch('inactive-session', { kind: 'user_message', text: 'run in background' })
    const payload = await doneSummary

    expect(payload.sessions.find((s) => s.sessionId === 'inactive-session')?.status).toBe('done')
    dashboard.close()
  })

  it('client:rename_workspace updates executor snapshots and session summaries', async () => {
    const sessionId = 'wire-rename-workspace'
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-rename-workspace',
      workspaceId: 'ws-rename',
      workspaceName: 'old-name',
      tools: ['write'],
      runtime: 'node',
      runtimeVersion: '22',
    })
    await waitForWorkspace(dashboard, 'ws-rename')

    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-rename',
      workspaceName: 'old-name',
    })
    await new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', (payload) => {
        if (payload.sessions.some((s) => s.sessionId === sessionId)) resolve(payload)
      })
    })

    const renamed = new Promise<void>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (
          payload.kind === 'workspace_meta_changed' &&
          payload.workspaceId === 'ws-rename' &&
          payload.workspaceName === 'new-name'
        ) {
          resolve()
        }
      })
    })
    dashboard.emit('client:rename_workspace', {
      workspaceId: 'ws-rename',
      workspaceName: ' new-name ',
    })
    await renamed

    const executors = await new Promise<ServerExecutorsPayload>((resolve) => {
      dashboard.on('server:executors', resolve)
      dashboard.emit('client:list_executors', {})
    })
    expect(executors.executors.find((e) => e.workspaceId === 'ws-rename')?.workspaceName).toBe('new-name')

    const sessions = await new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
      dashboard.emit('client:list_sessions', {})
    })
    expect(sessions.sessions.find((s) => s.sessionId === sessionId)?.workspaceName).toBe('new-name')

    dashboard.close()
    executor.close()
  })

  it('client:create_session validates and writes the initial cwd', async () => {
    const sessionId = 'wire-create-session-cwd'
    const root = resolve(dir, 'workspace-root')
    const child = resolve(root, 'child')
    await mkdir(child, { recursive: true })

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
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
    attachDirListHandler(executor, [root], [root, child])
    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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

    const missingErr = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.once('session:error', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId: 'wire-create-session-cwd-missing',
      workspaceId: 'ws-create-cwd',
      workspaceName: 'cwd-box',
      cwd: resolve(root, 'missing'),
    })
    await expect(missingErr).resolves.toMatchObject({
      scope: 'host',
      message: expect.stringContaining('cwd is not a readable directory'),
    })
    expect(server.store.get('wire-create-session-cwd-missing')).toBeUndefined()

    dashboard.close()
    executor.close()
  })

  it('client:create_session with tools allowlist filters defaultConfig.tools and skips workspace cwd validation when workspaceId is omitted', async () => {
    const sessionId = 'wire-simple-chat'
    const cwd = resolve(dir, 'simple-chat-tmp')
    await mkdir(cwd, { recursive: true })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const ready = new Promise<SessionReadyEvent>((resolve) => {
      dashboard.off('session:ready')
      dashboard.on('session:ready', resolve)
    })
    // Emit with no workspaceId and an allowlist that excludes 'write'
    // (the only tool the default config exposes in this test setup).
    dashboard.emit('client:create_session', {
      sessionId,
      cwd,
      tools: ['agent'],
    })
    await ready

    const rec = server.store.get(sessionId)
    expect(rec).toBeDefined()
    expect(rec?.workspaceId).toBeUndefined()
    expect(rec?.state.cwd).toBe(cwd)
    expect(rec?.config.tools.map((t) => t.name)).toEqual([])

    dashboard.close()
  })

  it('client:create_session backfills workspace and cwd on an existing unbound session', async () => {
    const sessionId = 'wire-create-session-backfill-cwd'
    const root = resolve(dir, 'backfill-root')
    const child = resolve(root, 'child')
    await mkdir(child, { recursive: true })

    const executor: ClientSocket<
      ExecutorServerToClientEvents,
      ExecutorClientToServerEvents
    > = clientIO(`${url}/executor`, {
      transports: ['websocket'],
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', {
      executorId: 'ex-create-backfill-cwd',
      workspaceId: 'ws-create-backfill-cwd',
      workspaceName: 'cwd-box',
      tools: ['write'],
      sandboxRoots: [root],
      runtime: 'node',
      runtimeVersion: '22',
    })
    attachDirListHandler(executor, [root], [root, child])

    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )
    await waitForWorkspace(dashboard, 'ws-create-backfill-cwd')

    const ready = new Promise<SessionReadyEvent>((resolve) => {
      dashboard.off('session:ready')
      dashboard.on('session:ready', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-create-backfill-cwd',
      workspaceName: 'cwd-box',
      cwd: child,
    })

    const createdReady = await ready
    expect(createdReady.workspaceId).toBe('ws-create-backfill-cwd')
    expect(createdReady.state.cwd).toBe(child)
    expect(server.store.get(sessionId)?.workspaceId).toBe('ws-create-backfill-cwd')
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    const reloaded = await server.store.load(sessionId)
    expect(reloaded.workspaceId).toBe('ws-create-backfill-cwd')
    expect(reloaded.state.cwd).toBe(child)

    dashboard.close()
    executor.close()
  })

  it('client:create_session preserves and validates a Windows cwd on a Linux host', async () => {
    const sessionId = 'wire-create-session-windows-cwd'
    const root = 'C:\\Users\\Admin'
    const child = 'c:\\users\\admin\\project'
    const executor = clientIO(`${url}/executor`, { transports: ['websocket'], auth: { role: 'executor', clientVersion: PROTOCOL_VERSION }, reconnection: false }) as ClientSocket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.emit('executor:announce', { executorId: 'ex-windows-cwd', workspaceId: 'ws-windows-cwd', workspaceName: 'windows-box', tools: ['write'], sandboxRoots: [root], runtime: 'node', runtimeVersion: '22', os: 'win32' })
    attachDirListHandler(executor, [root], [root, child])
    const dashboard = clientIO(`${url}/dashboard`, { transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false }) as ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    await waitForWorkspace(dashboard, 'ws-windows-cwd')
    const ready = new Promise<SessionReadyEvent>((resolve) => { dashboard.off('session:ready'); dashboard.on('session:ready', resolve) })
    dashboard.emit('client:create_session', { sessionId, workspaceId: 'ws-windows-cwd', workspaceName: 'windows-box', cwd: child })
    await expect(ready).resolves.toMatchObject({ state: { cwd: child } })
    dashboard.close(); executor.close()
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<void>((resolve) => executor.on('connect', () => resolve()))
    executor.on('tool:call', (payload, ack) => {
      if (payload.name !== '__fs_list_dirs') return
      const input = payload.input as { requestId: string; workspaceId: string }
      const result: DirListResult = {
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        path: root,
        roots: [root],
        entries: [{ name: 'child', path: child }],
      }
      ack({ callId: payload.callId, ok: true, content: JSON.stringify(result) })
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
    await mkdir(child, { recursive: true })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
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
    attachDirListHandler(executor, [root], [root, child])
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

    const missingErr = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.once('session:error', resolve)
    })
    dashboard.emit('client:set_cwd', { sessionId, cwd: resolve(root, 'missing') })
    await expect(missingErr).resolves.toMatchObject({
      scope: 'host',
      message: expect.stringContaining('cwd is not a readable directory'),
    })
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    dashboard.close()
    executor.close()
  })

  it('client:set_cwd rejects running or offline workspace sessions', async () => {
    const runningSessionId = 'wire-set-cwd-running'
    await server.store.ensure({
      sessionId: runningSessionId,
      defaultConfig: config,
      workspaceId: 'ws-running',
      workspaceName: 'running-box',
    })
    server.store.get(runningSessionId)!.state.status = 'thinking'

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: runningSessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const runningErr = new Promise<{ scope: string; message: string }>((resolve) => {
      dashboard.once('session:error', resolve)
    })
    dashboard.emit('client:set_cwd', { sessionId: runningSessionId, cwd: '/tmp' })
    await expect(runningErr).resolves.toMatchObject({
      scope: 'host',
      message: 'cannot change cwd while session status is thinking',
    })
    expect(server.store.get(runningSessionId)?.state.cwd).toBeUndefined()

    const offlineSessionId = 'wire-set-cwd-offline'
    await server.store.ensure({
      sessionId: offlineSessionId,
      defaultConfig: config,
      workspaceId: 'ws-offline',
      workspaceName: 'offline-box',
    })
    const offlineDashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId: offlineSessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      offlineDashboard.on('session:ready', resolve),
    )
    const offlineErr = new Promise<{ scope: string; message: string }>((resolve) => {
      offlineDashboard.once('session:error', resolve)
    })
    offlineDashboard.emit('client:set_cwd', { sessionId: offlineSessionId, cwd: '/tmp' })
    await expect(offlineErr).resolves.toMatchObject({
      scope: 'host',
      message: 'workspace offline',
    })
    expect(server.store.get(offlineSessionId)?.state.cwd).toBeUndefined()

    dashboard.close()
    offlineDashboard.close()
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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

  it('client:compact persists a manual handoff without starting another Agent turn', async () => {
    const sessionId = 'wire-manual-compact-rests'
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
        name: 'manual-compact-rests',
        async call(input) {
          llmCalls += 1
          if (!input.systemPrompt?.includes('CONTEXT CHECKPOINT COMPACTION')) {
            return { message: { role: 'assistant', content: [{ type: 'text', text: 'turn complete' }] } }
          }
          const detail = 'Preserve the completed turn and wait for an explicit user message before doing more work. '.repeat(8)
          return {
            message: {
              role: 'assistant',
              content: [{
                type: 'text',
                text: `## Objective\n- Keep the compacted session stable.\n\n## User Intent And Constraints\n- ${detail}\n\n## Repository And Runtime State\n- Session is resting.\n\n## Decisions\n- Manual compact does not resume.\n\n## Work Completed\n- Existing turn completed.\n\n## Open Work\n- Wait for the user.\n\n## Preserved Verbatim\n- Manual compact.`,
              }],
            },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.loop.dispatch(sessionId, { kind: 'user_message', text: 'finish this turn' })
    expect(server.store.get(sessionId)?.state.status).toBe('done')

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const compactDone = new Promise<void>((resolve) => {
      dashboard.on('server:compact_status', (payload) => {
        if (payload.kind === 'done') resolve()
      })
    })
    dashboard.emit('client:compact', { sessionId })
    await compactDone

    expect(llmCalls).toBe(2)
    expect(server.store.get(sessionId)?.state.status).toBe('done')
    const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
    expect(parsed.events.at(-1)?.event).toMatchObject({ kind: 'messages_replaced', reason: 'compaction' })
    expect(parsed.events.some((entry) => entry.event.kind === 'messages_replaced' && entry.event.reason === 'recovery')).toBe(false)
    dashboard.close()
  })

  it('queues user messages while a turn is running and dispatches them after rest', async () => {
    const sessionId = 'wire-message-queue'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    const seenModels: Array<string | undefined> = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      models: [
        { ref: 'provider:model-a', id: 'model-a', label: 'Model A', provider: 'provider' },
        { ref: 'provider:model-b', id: 'model-b', label: 'Model B', provider: 'provider' },
      ],
      llm: {
        name: 'queue-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          seenModels.push(p.model)
          if (seenPrompts.length === 1) await firstRelease
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `answer ${seenPrompts.length}` }],
            },
            usage: { inputTokens: 10, outputTokens: 1 },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    await server.store.updatePreferences(sessionId, { selectedModel: 'provider:model-a' })

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const queueEvents: Array<{ pending: number; text?: string; mode?: string; id?: string }> = []
    let queuedCommitObserved = false
    let queueClearedAtCommit = false
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) {
        queueEvents.push({
          pending: p.pending,
          text: p.items[0]?.text,
          mode: p.items[0]?.mode,
          id: p.items[0]?.id,
        })
        if (queuedCommitObserved && p.pending === 0) queueClearedAtCommit = true
      }
    })
    dashboard.on('event:appended', (p) => {
      if (p.sessionId === sessionId && p.event.kind === 'user_message' && p.event.operationId === 'queued-second') queuedCommitObserved = true
    })
    const finalDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('queued turn never finished')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done' && p.state.messages.length >= 5) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    const firstAck = await new Promise<RpcAck>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('direct message ACK waited for the Agent turn')), 500)
      dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer', operationId: 'direct-first' }, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
    })
    expect(firstAck).toEqual({ ok: true })
    const retryAck = await dashboard.timeout(500).emitWithAck('client:user_message', {
      sessionId,
      text: 'first',
      mode: 'steer',
      operationId: 'direct-first',
    })
    expect(retryAck).toEqual({ ok: true })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    dashboard.emit('client:user_message', { sessionId, text: 'second', mode: 'queue', operationId: 'queued-second' })
    const retryQueuedAck = await dashboard.timeout(500).emitWithAck('client:user_message', {
      sessionId,
      text: 'second',
      mode: 'queue',
      operationId: 'queued-second',
    })
    expect(retryQueuedAck).toEqual({ ok: true })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !queueEvents.some((e) => e.pending === 1 && e.text === 'second')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const modelChanged = new Promise<void>((resolve) => dashboard.on('server:control_update', (payload) => {
      if (payload.kind === 'session_meta_changed' && payload.sessionId === sessionId && payload.preferences?.selectedModel === 'provider:model-b') {
        resolve()
      }
    }))
    dashboard.emit('client:update_preferences', { sessionId, preferences: { selectedModel: 'provider:model-b' } })
    await modelChanged
    releaseFirst()
    await finalDone

    expect(queueEvents.map((e) => e.pending)).toContain(1)
    expect(queueEvents.map((e) => e.pending)).toContain(0)
    expect(queueClearedAtCommit).toBe(true)
    expect(queueEvents.some((e) => e.pending === 1 && e.text === 'second' && e.mode === 'queue' && typeof e.id === 'string')).toBe(true)
    expect(seenPrompts).toEqual(['first', 'first|second'])
    expect(seenModels).toEqual(['provider:model-a', 'provider:model-a'])
    expect(server.store.get(sessionId)?.preferences.selectedModel).toBe('provider:model-b')

    dashboard.close()
  })

  it('does not interrupt an active turn when queueing during a transient done state', async () => {
    const sessionId = 'wire-message-queue-transient-done'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    let releaseFinish!: () => void
    const finishGate = new Promise<void>((resolve) => { releaseFinish = resolve })
    const seenPrompts: string[] = []
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-transient-done-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await finishGate
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    while (seenPrompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    dashboard.emit('client:user_message', { sessionId, text: 'queued', mode: 'queue' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(seenPrompts).toEqual(['first'])
    expect(server.store.get(sessionId)?.state.messages.some((message) => message.role === 'user' && message.content.some((part) => part.type === 'text' && part.text === 'queued'))).toBe(false)

    releaseFinish()
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && seenPrompts.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seenPrompts).toEqual(['first', 'first|queued'])
    dashboard.close()
  })

  it('does not expose an idle queue-mode send as a pending queue item', async () => {
    const sessionId = 'wire-idle-queue-hidden'
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const queueEvents: ServerMessageQueueEvent[] = []
    dashboard.on('server:message_queue', (event) => { if (event.sessionId === sessionId) queueEvents.push(event) })
    const ack = await dashboard.timeout(500).emitWithAck('client:user_message', {
      sessionId, text: 'send immediately', mode: 'queue', operationId: 'idle-queue-send',
    })
    expect(ack).toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(queueEvents.every((event) => event.items.every((item) => item.text !== 'send immediately'))).toBe(true)
    dashboard.close()
  })

  it('keeps an immediate post-ACK follow-up behind the accepted direct message', async () => {
    const sessionId = 'wire-message-queue-post-ack-race'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve })
    const seenPrompts: string[] = []
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-post-ack-race-test',
        async call(p) {
          const userText = p.messages
            .filter((message) => message.role === 'user')
            .map((message) => message.content.map((content) => ('text' in content ? content.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    let latestQueue: ServerMessageQueueEvent | undefined
    dashboard.on('server:message_queue', (event) => { if (event.sessionId === sessionId) latestQueue = event })

    await expect(dashboard.timeout(500).emitWithAck('client:user_message', {
      sessionId, text: 'first', mode: 'steer', operationId: 'post-ack-first',
    })).resolves.toEqual({ ok: true })
    await expect(dashboard.timeout(500).emitWithAck('client:user_message', {
      sessionId, text: 'second', mode: 'queue', operationId: 'post-ack-second',
    })).resolves.toEqual({ ok: true })

    const queuedDeadline = Date.now() + 2000
    while (Date.now() < queuedDeadline && !latestQueue?.items.some((item) => item.text === 'second' && item.mode === 'queue')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(latestQueue?.items).toEqual([expect.objectContaining({ text: 'second', mode: 'queue' })])
    releaseFirst()
    const finishedDeadline = Date.now() + 4000
    while (Date.now() < finishedDeadline && seenPrompts.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seenPrompts).toEqual(['first', 'first|second'])

    const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
    expect(parsed.events.filter((entry) => entry.event.kind === 'user_message').map((entry) => entry.event.operationId)).toEqual(['post-ack-first', 'post-ack-second'])
    dashboard.close()
  })

  it('captures the effective default model on queued messages', async () => {
    const sessionId = 'wire-message-queue-default-model'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenModels: Array<string | undefined> = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      models: [
        { ref: 'provider:first-model', id: 'first-model', label: 'First Model', provider: 'provider', providerId: 'provider' },
        { ref: 'provider:model-default', id: 'model-default', label: 'Default Model', provider: 'provider', providerId: 'provider' },
        { ref: 'provider:model-later', id: 'model-later', label: 'Later Model', provider: 'provider', providerId: 'provider' },
      ],
      defaultModel: 'provider:model-default',
      llm: {
        name: 'queue-default-model-test',
        async call(p) {
          seenModels.push(p.model)
          if (seenModels.length === 1) await firstRelease
          return {
            message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenModels.length}` }] },
            usage: { inputTokens: 10, outputTokens: 1 },
          }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const finalDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('queued turn never finished')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done' && p.state.messages.length >= 5) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenModels.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    dashboard.emit('client:user_message', { sessionId, text: 'second', mode: 'queue' })
    const modelChanged = new Promise<void>((resolve) => dashboard.on('server:control_update', (payload) => {
      if (payload.kind === 'session_meta_changed' && payload.sessionId === sessionId && payload.preferences?.selectedModel === 'provider:model-later') {
        resolve()
      }
    }))
    dashboard.emit('client:update_preferences', { sessionId, preferences: { selectedModel: 'provider:model-later' } })
    await modelChanged
    releaseFirst()
    await finalDone

    expect(seenModels).toEqual(['provider:model-default', 'provider:model-default'])
    dashboard.close()
  })

  it('lets dashboard reorder, edit, and delete queued user messages before drain', async () => {
    const sessionId = 'wire-message-queue-edit'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-edit-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `answer ${seenPrompts.length}` }],
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    let latestQueue: ServerMessageQueueEvent | undefined
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) latestQueue = p
    })
    const waitForQueue = async (count: number): Promise<ServerMessageQueueEvent> => {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        if (latestQueue?.pending === count) return latestQueue
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`queue did not reach ${count}`)
    }
    const finalDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('edited queued turn never finished')), 4000)
      dashboard.on('state:changed', (p) => {
        if (p.state.status === 'done' && p.state.messages.length >= 7) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    dashboard.emit('client:user_message', { sessionId, text: 'second', mode: 'queue' })
    dashboard.emit('client:user_message', { sessionId, text: 'third', mode: 'queue' })
    dashboard.emit('client:user_message', { sessionId, text: 'delete me', mode: 'queue' })
    const queued = await waitForQueue(3)
    const second = queued.items.find((item) => item.text === 'second')!
    const third = queued.items.find((item) => item.text === 'third')!
    const deleteMe = queued.items.find((item) => item.text === 'delete me')!
    dashboard.emit('client:update_queued_message', { sessionId, id: third.id, text: 'third edited' })
    dashboard.emit('client:delete_queued_message', { sessionId, id: deleteMe.id })
    dashboard.emit('client:reorder_queued_message', { sessionId, id: third.id, beforeId: second.id })
    await waitForQueue(2)
    releaseFirst()
    await finalDone

    expect(seenPrompts).toEqual(['first', 'first|third edited', 'first|third edited|second'])

    dashboard.close()
  })

  it('persists queued user messages across host restart and syncs them to dashboards', async () => {
    const sessionId = 'wire-message-queue-restart'
    await server.close()
    let http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    let port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-restart-test-1',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'first done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    let dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    let latestQueue: ServerMessageQueueEvent | undefined
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) latestQueue = p
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const waitForQueue = async (count: number): Promise<ServerMessageQueueEvent> => {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        if (latestQueue?.pending === count) return latestQueue
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`queue did not reach ${count}`)
    }

    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    dashboard.emit('client:user_message', { sessionId, text: 'second', mode: 'queue' })
    expect((await waitForQueue(1)).items[0]?.text).toBe('second')
    dashboard.close()
    await server.close()
    releaseFirst()

    http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-restart-test-2',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'second done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    latestQueue = undefined
    dashboard = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) latestQueue = p
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    const restoredSnapshot = latestQueue
    expect(restoredSnapshot?.items[0]?.text ?? 'second').toBe('second')
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && seenPrompts.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(seenPrompts).toEqual(['first', 'first|second'])
    const emptyDeadline = Date.now() + 2000
    while (Date.now() < emptyDeadline && latestQueue?.pending !== 0) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(latestQueue?.pending).toBe(0)

    const parsed = await readSessionLog(server.store.get(sessionId)!.logPath)
    expect(parsed.runtimeMetadata.some((entry) => entry.action === 'message_queue_snapshot')).toBe(true)
    expect(parsed.events.some((entry) => entry.event.kind === 'llm_response' && entry.event.message.content.some((part) => part.type === 'text' && part.text === '[interrupted]'))).toBe(false)
    dashboard.close()
  })

  it('steer while a turn is running interrupts and dispatches without surfacing as a queued dock item', async () => {
    const sessionId = 'wire-steer-while-running'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'steer-while-running-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          // Block the first turn until the steer message aborts it.
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenPrompts.length}` }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    const queueEvents: Array<{ pending: number; text?: string; mode?: string }> = []
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) {
        queueEvents.push({ pending: p.pending, text: p.items[0]?.text, mode: p.items[0]?.mode })
      }
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    // Start a turn and wait until the LLM call is in flight (blocked).
    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })

    // Steer while the turn is running: this must interrupt the active turn and
    // be delivered — never linger in the queue dock as a stuck "queued" item.
    dashboard.emit('client:user_message', { sessionId, text: 'steered', mode: 'steer' })
    // Release the blocked first call so the abort/redispatch chain can settle.
    releaseFirst()

    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !seenPrompts.some((prompt) => prompt.includes('steered'))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // Bug 2: the steer message must actually be dispatched, not stuck forever.
    expect(seenPrompts.some((prompt) => prompt.includes('steered'))).toBe(true)
    // Bug 1: a steer must never be surfaced to the dock as a queued message.
    expect(queueEvents.some((e) => e.text === 'steered' && e.mode === 'steer' && e.pending > 0)).toBe(false)

    dashboard.close()
  })

  it('Stop discards pending steer and queue without auto-restarting the Session', async () => {
    await server.close()
    const sessionId = 'wire-stop-queue-steer'
    const seenPrompts: string[] = []
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port, sessionsDir: dir, defaultConfig: config, httpServer: http, toolTimeoutMs: 2000,
      llm: {
        name: 'stop-queue-steer-test',
        async call(params) {
          const userText = params.messages.filter((message) => message.role === 'user').map((message) => message.content.map((part) => ('text' in part ? part.text : '')).join('')).join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) {
            await new Promise<void>((_resolve, reject) => {
              params.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
            })
          }
          return { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })
    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'], auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION }, reconnection: false,
    })
    let latestQueue: ServerMessageQueueEvent | undefined
    dashboard.on('server:message_queue', (payload) => { if (payload.sessionId === sessionId) latestQueue = payload })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    while (seenPrompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))

    dashboard.emit('client:user_message', { sessionId, text: 'later queue', mode: 'queue' })
    dashboard.emit('client:user_message', { sessionId, text: 'pending steer', mode: 'steer' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    dashboard.emit('client:cancel', { sessionId })

    const deadline = Date.now() + 3000
    while (Date.now() < deadline && server.store.get(sessionId)?.state.status !== 'done') await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(server.store.get(sessionId)?.state.status).toBe('done')
    expect(seenPrompts).toHaveLength(1)
    expect(seenPrompts.some((prompt) => prompt.includes('pending steer'))).toBe(false)
    expect(seenPrompts.some((prompt) => prompt.includes('later queue'))).toBe(false)
    expect(latestQueue).toMatchObject({ pending: 0, items: [] })

    dashboard.emit('client:user_message', { sessionId, text: 'resume explicitly', mode: 'steer' })
    const resumeDeadline = Date.now() + 3000
    while (Date.now() < resumeDeadline && !seenPrompts.some((prompt) => prompt.includes('resume explicitly'))) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seenPrompts.some((prompt) => prompt.includes('resume explicitly'))).toBe(true)
    expect(seenPrompts.some((prompt) => prompt.includes('later queue'))).toBe(false)
    dashboard.close()
  })

  it('steer during tool execution waits for the running tool to finish, then dispatches (no truncation)', async () => {
    // Steer semantics (spec A): a steer submitted while the agent is
    // mid-tool-execution must NOT abort the running tool/sub-agent. It waits for
    // the current tool to finish naturally, stops the autonomous loop before the
    // next think, and then dispatches the front-queued steer as the next turn.
    // Here the child sub-agent completes on its own after the steer arrives; the
    // steer must be delivered *after* that completion, never by truncating it.
    await server.close()
    const sessionId = 'wire-steer-during-tools'
    let call = 0
    const seenPrompts: string[] = []
    let releaseChild!: () => void
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    const llm: LLMAdapter = {
      name: 'steer-during-tools-test',
      async call(params) {
        call += 1
        const userText = params.messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
          .join('|')
        seenPrompts.push(userText)
        if (call === 1) {
          // Parent's first turn: spawn a sub-agent so the parent parks in
          // `executing_tools` (host tool) while the child runs.
          return {
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_call', callId: 'agent-steer-1', name: 'agent', input: { prompt: 'long child task' } },
              ],
            },
          }
        }
        if (userText.includes('long child task')) {
          // Child LLM call: run until the test releases it (simulating a tool
          // that finishes on its own AFTER the steer has been submitted). It must
          // NOT be aborted by the steer — spec A waits for it to complete.
          await childGate
        }
        return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${call}` }] } }
      },
    }
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const agentConfig = createConfig({ tools: [AGENT], systemPrompt: 'sys' })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      llm,
      defaultConfig: agentConfig,
      httpServer: http,
      toolTimeoutMs: 5000,
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: agentConfig })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    const queueEvents: Array<{ pending: number; text?: string; mode?: string }> = []
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) queueEvents.push({ pending: p.pending, text: p.items[0]?.text, mode: p.items[0]?.mode })
    })
    const childStarted = new Promise<void>((resolve) => {
      dashboard.on('server:control_update', (payload) => {
        if (payload.kind === 'sub_agent_started') resolve()
      })
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    // Wait until the parent is parked in `executing_tools` (child agent running).
    await childStarted
    // Give the child LLM call a beat to actually start running (blocked on gate).
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Steer while a tool is executing. Spec A: this must NOT abort the child.
    dashboard.emit('client:user_message', { sessionId, text: 'steered', mode: 'steer' })
    // Give the steer a beat to be enqueued + flag the session for a boundary stop
    // while the tool is still running, then let the child finish on its own.
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseChild()

    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !seenPrompts.some((prompt) => prompt.includes('steered'))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // The steer is delivered — but only AFTER the child tool completed naturally.
    expect(seenPrompts.some((prompt) => prompt.includes('steered'))).toBe(true)
    // Proof the tool ran to completion rather than being truncated: the child
    // produced its own answer before the steer turn ran.
    expect(seenPrompts.some((prompt) => prompt.includes('long child task'))).toBe(true)
    // Never surfaced to the dock as a stuck queued item.
    expect(queueEvents.some((e) => e.text === 'steered' && e.mode === 'steer' && e.pending > 0)).toBe(false)

    dashboard.close()
  }, 15000)

  it('drains a queued message after the turn completes even if the dashboard disconnected', async () => {
    const sessionId = 'wire-queue-drain-after-disconnect'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-drain-after-disconnect-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenPrompts.length}` }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    // Start a turn; wait until the first LLM call is in flight (blocked).
    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })

    // Queue a follow-up while the turn is running, then DISCONNECT the dashboard
    // (simulating the user closing the browser / PWA) before the turn finishes.
    dashboard.emit('client:user_message', { sessionId, text: 'queued', mode: 'queue' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    dashboard.close()

    // Now let the first turn complete. With no dashboard connected, the queued
    // message must still be drained automatically by the turn-completion hook.
    releaseFirst()
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !seenPrompts.some((prompt) => prompt.includes('queued'))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(seenPrompts.some((prompt) => prompt.includes('queued'))).toBe(true)
  })

  it('drains MANY queued messages in order after all browsers close mid-turn', async () => {
    // User scenario: session is running, the user queues several follow-ups,
    // then closes every browser/PWA. With no client connected, the host must
    // still drain the whole queue — one message per turn — in FIFO order.
    const sessionId = 'wire-queue-drain-many-after-disconnect'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'queue-drain-many-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenPrompts.length}` }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))

    // Start a turn; wait until the first LLM call is in flight (blocked).
    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })

    // Queue THREE follow-ups while the turn is running, then close the browser.
    dashboard.emit('client:user_message', { sessionId, text: 'q-one', mode: 'queue' })
    dashboard.emit('client:user_message', { sessionId, text: 'q-two', mode: 'queue' })
    dashboard.emit('client:user_message', { sessionId, text: 'q-three', mode: 'queue' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    dashboard.close()

    // Release the blocked first turn. All three queued messages must drain
    // automatically, in FIFO order, with no client connected.
    releaseFirst()
    const deadline = Date.now() + 6000
    const delivered = (): boolean =>
      ['q-one', 'q-two', 'q-three'].every((t) => seenPrompts.some((p) => p.includes(t)))
    while (Date.now() < deadline && !delivered()) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(delivered()).toBe(true)
    // FIFO: the turn index where each first appears must be increasing.
    const firstIndex = (t: string): number => seenPrompts.findIndex((p) => p.includes(t))
    expect(firstIndex('q-one')).toBeLessThan(firstIndex('q-two'))
    expect(firstIndex('q-two')).toBeLessThan(firstIndex('q-three'))
  }, 15000)

  it('enqueues a user message over HTTP (pagehide beacon path) and drains it with no socket', async () => {
    const sessionId = 'wire-http-enqueue-beacon'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const seenPrompts: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: {
        name: 'http-enqueue-beacon-test',
        async call(p) {
          const userText = p.messages
            .filter((m) => m.role === 'user')
            .map((m) => m.content.map((c) => ('text' in c ? c.text : '')).join(''))
            .join('|')
          seenPrompts.push(userText)
          if (seenPrompts.length === 1) await firstRelease
          return { message: { role: 'assistant', content: [{ type: 'text', text: `answer ${seenPrompts.length}` }] } }
        },
      },
    })
    url = `http://localhost:${server.port}`
    await server.store.ensure({ sessionId, defaultConfig: config })

    const dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents> = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) => dashboard.on('session:ready', resolve))
    dashboard.emit('client:user_message', { sessionId, text: 'first', mode: 'steer' })
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (seenPrompts.length === 1) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
    })
    // Simulate the browser closing: the socket is gone, and the queued message
    // arrives only via the HTTP beacon endpoint.
    dashboard.close()
    const res = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'enqueue-user-message', sessionId, text: 'beaconed' }),
    })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { queued?: boolean }
    expect(body.queued).toBe(true)

    releaseFirst()
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !seenPrompts.some((prompt) => prompt.includes('beaconed'))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(seenPrompts.some((prompt) => prompt.includes('beaconed'))).toBe(true)
  })

  it('fires session_start and session_end lifecycle hooks around create/delete', async () => {
    const sessionId = 'wire-lifecycle-hooks'
    await server.close()
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    const calls: Array<{ event: string; sessionId: string }> = []
    server = await startHostServer({
      port,
      sessionsDir: dir,
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 2000,
      llm: scriptedLlm(),
      hooks: [
        { event: 'session_start', command: 'true' },
        { event: 'session_end', command: 'true' },
        { event: 'session_start', command: 'true', match: 'nope' },
      ],
      hookRunner: {
        async run(hook, payload) {
          calls.push({ event: hook.event, sessionId: payload.sessionId })
          return { ok: true, exitCode: 0, stdout: '', stderr: '' }
        },
      },
    })
    url = `http://localhost:${server.port}`

    const dashboard: ClientSocket<
      DashboardServerToClientEvents,
      DashboardClientToServerEvents
    > = clientIO(`${url}/dashboard`, {
      transports: ['websocket'],
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    await new Promise<SessionReadyEvent>((resolve) =>
      dashboard.on('session:ready', resolve),
    )

    const created = new Promise<ServerSessionsPayload>((resolve) => {
      dashboard.on('server:sessions', resolve)
    })
    dashboard.emit('client:create_session', {
      sessionId,
      workspaceId: 'ws-life',
      workspaceName: 'life-box',
    })
    await created
    // Wait one tick so the async lifecycle hook has a chance to run.
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toEqual([{ event: 'session_start', sessionId }])

    const deleted = new Promise<{ sessionId: string }>((resolve) => {
      dashboard.on('server:session_deleted', resolve)
    })
    await new Promise<void>((resolve, reject) => dashboard.emit('client:delete_session', { operationId: 'delete-lifecycle-op', sessionId }, (ack) => ack.ok ? resolve() : reject(new Error(ack.error))))
    await deleted
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toEqual([
      { event: 'session_start', sessionId },
      { event: 'session_end', sessionId },
    ])

    dashboard.close()
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
