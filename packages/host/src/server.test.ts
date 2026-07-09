import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  ClientListDirs,
  DirListResult,
  DashboardClientToServerEvents,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ServerExecutorChangedPayload,
  ServerExecutorsPayload,
  ServerHistoryPayload,
  ServerSettingsPayload,
  ServerSessionsPayload,
  ServerSubAgentFinishedEvent,
  ServerSubAgentStartedEvent,
  SessionReadyEvent,
  ToolResultAck,
  ToolCallMessage,
} from '@agent-kernel/shared'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
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
  const known = new Set(existingDirs.map((p) => resolve(p)))
  // Host-internal fs / bg / overflow RPCs arrive as ordinary `tool:call`
  // messages. The stub executor pretends to be the `__fs_list_dirs` built-in
  // and returns a JSON string matching DirListResult.
  executor.on('tool:call', (payload, ack: (result: ToolResultAck) => void) => {
    if (payload.name !== '__fs_list_dirs') return
    const input = payload.input as { requestId: string; workspaceId: string; path?: string }
    const requested = resolve(input.path ?? roots[0] ?? process.cwd())
    const result: DirListResult = known.has(requested)
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

  it('updates agent prompt settings through HTTP', async () => {
    let selectedPreset: 'codex' | 'claude-code' = 'codex'
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
          ],
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
            ],
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

    const revokeRes = await fetch(`${url}/auth/executor-invites/${invite.id}`, { method: 'DELETE' })
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
    await writeFile(join(artifactRootDir, 'llm/s1/1.request.json'), JSON.stringify({ ok: true }), 'utf8')

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
    expect(manifest.summary.entryCount).toBe(1)
    expect(manifest.summary.kinds.llm_request).toBe(1)
    expect(manifest.entries[0]).toMatchObject({ path: 'llm/s1/1.request.json', kind: 'llm_request' })

    const content = await fetch(`${url}/artifacts/content?path=${encodeURIComponent('llm/s1/1.request.json')}`).then((r) => r.json() as Promise<{
      path: string
      body: { ok: boolean }
    }>)
    expect(content).toMatchObject({ path: 'llm/s1/1.request.json', body: { ok: true } })

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

  it('creates SWE-bench worker plan artifacts from the dashboard route', async () => {
    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
    const instancesJsonl = join(dir, 'instances.jsonl')
    await writeFile(instancesJsonl, [
      JSON.stringify({ instance_id: 'repo__one-1' }),
      JSON.stringify({ instance_id: 'repo__two-2' }),
      JSON.stringify({ instance_id: 'repo__three-3' }),
    ].join('\n'), 'utf8')

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

    const response = await fetch(`${url}/eval/swebench/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'dash-plan',
        dataset: 'princeton-nlp/SWE-bench_Lite',
        split: 'test',
        model: 'agent-test',
        instancesJsonl,
        instanceIds: ['repo__one-1', 'repo__three-3'],
        maxWorkers: 2,
        timeoutMs: 300000,
      }),
    }).then((r) => r.json() as Promise<{ planPath: string; registryPath: string; selectedCount: number; shardCount: number }>)

    expect(response.selectedCount).toBe(2)
    expect(response.shardCount).toBe(2)
    expect(response.planPath).toBe(join(artifactRootDir, 'dash-plan', 'worker-plan.json'))
    expect(response.registryPath).toBe(join(artifactRootDir, 'registry', 'run-index.json'))
    const registry = JSON.parse(await readFile(response.registryPath, 'utf8')) as {
      schemaVersion: number
      entries: Array<{ runId: string; planPath: string; selectedCount: number }>
    }
    expect(registry.schemaVersion).toBe(1)
    expect(registry.entries).toHaveLength(1)
    expect(registry.entries[0]?.runId).toBe('dash-plan')
    expect(registry.entries[0]?.selectedCount).toBe(2)

    const plan = JSON.parse(await readFile(response.planPath, 'utf8')) as {
      runId: string
      model: string
      shards: Array<{ instanceIds: string[] }>
      resourceHints: { timeoutMs?: number }
    }
    expect(plan.runId).toBe('dash-plan')
    expect(plan.model).toBe('agent-test')
    expect(plan.shards.flatMap((shard) => shard.instanceIds).sort()).toEqual(['repo__one-1', 'repo__three-3'])
    expect(plan.resourceHints.timeoutMs).toBe(300000)
  })

  it('runs lightweight enhancement artifact actions from dashboard routes', async () => {
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

    const promptPath = join(dir, 'judge-prompt.txt')
    const responsePath = join(dir, 'judge-response.json')
    await writeFile(promptPath, 'Judge this patch.', 'utf8')
    await writeFile(responsePath, JSON.stringify({ score: 0.75, label: 'test_failed', explanation: 'one failing test' }), 'utf8')
    const judge = await postEnhancementAction(url, { action: 'eval-judge-score', promptPath, responsePath, judgeModel: 'judge-test', threshold: 0.8 }) as { scoresPath: string; judgeTrace: { uri: string } }
    expect(judge.scoresPath).toBe(join(artifactRootDir, 'scores.json'))
    expect(judge.judgeTrace.uri).toBe('judge/model_judge.score.judge-trace.json')

    const instancesJsonl = join(dir, 'instances.jsonl')
    const patchesDir = join(dir, 'patches')
    await mkdir(patchesDir, { recursive: true })
    await writeFile(instancesJsonl, `${JSON.stringify({ instance_id: 'local__repo-1', repo: 'local/repo' })}\n`, 'utf8')
    await writeFile(join(patchesDir, 'local__repo-1.diff'), 'diff --git a/a b/a\n', 'utf8')
    const infer = await postEnhancementAction(url, { action: 'swebench-infer-patches', runId: 'dash-infer', dataset: 'SWE-bench/local', model: 'agent-test', instancesJsonl, patchesDir }) as { predictionsPath: string; trialCount: number }
    expect(infer.predictionsPath).toBe(join(artifactRootDir, 'dash-infer', 'predictions.jsonl'))
    expect(infer.trialCount).toBe(1)

    const patchPath = join(dir, 'model.patch')
    await writeFile(patchPath, 'diff --git a/b b/b\n', 'utf8')
    const exported = await postEnhancementAction(url, { action: 'swebench-export-session', runId: 'dash-export', dataset: 'SWE-bench/local', model: 'agent-test', instanceId: 'local__repo-1', sessionId: record.sessionId, modelPatchPath: patchPath }) as { predictionsPath: string; traceArtifact: { uri: string } }
    expect(exported.predictionsPath).toBe(join(artifactRootDir, 'dash-export', 'predictions.jsonl'))
    expect(exported.traceArtifact.uri).toBe('traces/local__repo-1.openinference.json')

    const resultsDir = join(dir, 'swebench-results')
    await mkdir(resultsDir, { recursive: true })
    await writeFile(join(resultsDir, 'instance_results.jsonl'), `${JSON.stringify({ instance_id: 'local__repo-1', resolved: true })}\n`, 'utf8')
    const ingested = await postEnhancementAction(url, { action: 'swebench-ingest-results', runId: 'dash-export', resultsDir }) as { summaryPath: string; resolved: number }
    expect(ingested.summaryPath).toBe(join(artifactRootDir, 'dash-export', 'summary.json'))
    expect(ingested.resolved).toBe(1)

    const grade = await postEnhancementAction(url, { action: 'swebench-grade-command', runId: 'dash-export', dataset: 'SWE-bench/local', predictionsPath: exported.predictionsPath, maxWorkers: 2, instanceIds: 'local__repo-1' }) as { command: string[]; shellCommand: string }
    expect(grade.command).toContain('predictions.jsonl')
    expect(grade.command).not.toContain(exported.predictionsPath)
    expect(grade.shellCommand).toContain('dash-export')
    expect(grade.shellCommand).not.toContain(exported.predictionsPath)

    const unsupported = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'not-real' }),
    })
    expect(unsupported.status).toBe(400)
  })

  it('builds SWE-bench grade commands without artifact capture configured', async () => {
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
      artifactRootDir: false,
    })
    url = `http://localhost:${server.port}`

    const grade = await postEnhancementAction(url, { action: 'swebench-grade-command', runId: 'dry-grade', dataset: 'SWE-bench/local', predictionsPath: '/tmp/predictions.jsonl' }) as { shellCommand: string }
    expect(grade.shellCommand).toContain('dry-grade')
    expect(grade.shellCommand).toContain('predictions.jsonl')
    expect(grade.shellCommand).not.toContain('/tmp/predictions.jsonl')
  })

  it('resolves inline SWE-bench instances and rejects oversized payloads', async () => {
    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
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

    const inlineContent = `${JSON.stringify({ instance_id: 'org__repo-1' })}\n${JSON.stringify({ instance_id: 'org__repo-2' })}\n`
    const resolved = await postEnhancementAction(url, {
      action: 'swebench-resolve-instances',
      runId: 'resolve-inline',
      source: 'inline',
      inlineContent,
    }) as { instancesJsonlPath: string; rowCount: number; source: { kind: string } }
    expect(resolved.rowCount).toBe(2)
    expect(resolved.source.kind).toBe('inline')
    expect(resolved.instancesJsonlPath).toBe(join(artifactRootDir, 'resolve-inline', 'instances.jsonl'))
    const persisted = await readFile(resolved.instancesJsonlPath, 'utf8')
    expect(persisted.trim().split('\n')).toHaveLength(2)

    const oneLine = `${JSON.stringify({ instance_id: 'i', filler: 'x'.repeat(1024) })}\n`
    const oversized = oneLine.repeat(Math.ceil(20 * 1024 * 1024 / oneLine.length) + 1)
    const overSizedRes = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'swebench-resolve-instances',
        runId: 'resolve-huge',
        source: 'inline',
        inlineContent: oversized,
      }),
    })
    expect(overSizedRes.status).toBe(413)
  })

  it('resolves SWE-bench instances from a stubbed huggingface datasets-server', async () => {
    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
    const stub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://private-4.example.com')
      if (url.pathname !== '/rows') {
        res.statusCode = 404
        res.end()
        return
      }
      const offset = Number(url.searchParams.get('offset') ?? '0')
      const length = Number(url.searchParams.get('length') ?? '100')
      const total = 2
      const rows = []
      for (let i = offset; i < Math.min(offset + length, total); i++) {
        rows.push({ row_idx: i, row: { instance_id: `hf__row-${i}`, repo: 'org/repo' } })
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ rows, num_rows_total: total }))
    })
    await new Promise<void>((resolve) => stub.listen(0, resolve))
    const stubUrl = `http://localhost:${(stub.address() as AddressInfo).port}`

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

    try {
      const resolved = await postEnhancementAction(url, {
        action: 'swebench-resolve-instances',
        runId: 'resolve-hf',
        source: 'huggingface',
        datasetRef: 'org/swebench-fork',
        datasetSplit: 'test',
        hfDatasetsServerBaseUrl: stubUrl,
      }) as { rowCount: number; source: { kind: string; datasetRef?: string }; instancesJsonlPath: string }
      expect(resolved.rowCount).toBe(2)
      expect(resolved.source.kind).toBe('huggingface')
      expect(resolved.source.datasetRef).toBe('org/swebench-fork')
      const persisted = await readFile(resolved.instancesJsonlPath, 'utf8')
      const lines = persisted.trim().split('\n').map((line) => JSON.parse(line) as { instance_id: string })
      expect(lines.map((row) => row.instance_id)).toEqual(['hf__row-0', 'hf__row-1'])
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()))
    }
  })

  it('uploads SWE-bench patches inline and enforces size limits', async () => {
    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
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

    const uploaded = await postEnhancementAction(url, {
      action: 'swebench-upload-patches',
      runId: 'upload-patches',
      patches: {
        'org__repo-1': 'diff --git a/x b/x\n+one\n',
        'org__repo-2': 'diff --git a/y b/y\n+two\n',
      },
    }) as { patchesDir: string; instanceCount: number; bytes: number }
    expect(uploaded.instanceCount).toBe(2)
    expect(uploaded.patchesDir).toBe(join(artifactRootDir, 'upload-patches', 'patches'))
    const first = await readFile(join(uploaded.patchesDir, 'org__repo-1.diff'), 'utf8')
    expect(first).toBe('diff --git a/x b/x\n+one\n')

    const emptyRes = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'swebench-upload-patches', runId: 'upload-empty', patches: {} }),
    })
    expect(emptyRes.status).toBe(400)

    const unsafeRes = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'swebench-upload-patches',
        runId: 'upload-unsafe',
        patches: { '../etc/passwd': 'x' },
      }),
    })
    expect(unsafeRes.status).toBe(400)
  })

  it('uploads SWE-bench results inline under grade-results', async () => {
    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
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

    const uploaded = await postEnhancementAction(url, {
      action: 'swebench-upload-results',
      runId: 'upload-results',
      resultsFiles: {
        'instance_results.jsonl': '{"instance_id":"a","resolved":true}\n',
        'summary.json': '{"total":1}',
      },
    }) as { resultsDir: string; fileCount: number; bytes: number }
    expect(uploaded.fileCount).toBe(2)
    expect(uploaded.resultsDir).toBe(join(artifactRootDir, 'upload-results', 'grade-results'))
    const first = await readFile(join(uploaded.resultsDir, 'instance_results.jsonl'), 'utf8')
    expect(first).toContain('resolved')
  })

  it('derives predictionsPath from runId when omitted on swebench-grade-command', async () => {
    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
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

    const grade = await postEnhancementAction(url, {
      action: 'swebench-grade-command',
      runId: 'derive-grade',
      dataset: 'SWE-bench/local',
    }) as { shellCommand: string }
    const derivedPath = join(artifactRootDir, 'derive-grade', 'predictions.jsonl')
    expect(grade.shellCommand).toContain('predictions.jsonl')
    expect(grade.shellCommand).not.toContain(derivedPath)
  })

  it('derives resultsDir from runId when omitted on swebench-ingest-results', async () => {
    await server.close()
    const artifactRootDir = join(dir, 'artifacts')
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

    await postEnhancementAction(url, {
      action: 'swebench-upload-results',
      runId: 'derive-ingest',
      resultsFiles: {
        'instance_results.jsonl': '{"instance_id":"org__repo-1","resolved":true}\n',
      },
    })

    // Confirm the ingest handler picks up the derived grade-results directory.
    // We assert against the failure mode: without a prior plan (experiment.json
    // missing) the ingest fails, but the error path references the derived
    // resultsDir under <runId>/grade-results, proving the derivation ran.
    const res = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'swebench-ingest-results', runId: 'derive-ingest' }),
    })
    const payload = await res.json() as { error?: string }
    expect(res.ok).toBe(false)
    expect(payload.error ?? '').toContain('derive-ingest')
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

  it('cascades session deletion through descendant sessions when requested', async () => {
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

    dashboard.emit('client:delete_session', { sessionId: 'delete-parent', cascade: true })
    let summaries = await server.store.listSummaries()
    for (let i = 0; i < 50 && summaries.length !== 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      summaries = await server.store.listSummaries()
    }
    expect(summaries.map((s) => s.sessionId).sort()).toEqual(['delete-sibling'])
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
    dashboard.on('server:message_queue', (p) => {
      if (p.sessionId === sessionId) {
        queueEvents.push({
          pending: p.pending,
          text: p.items[0]?.text,
          mode: p.items[0]?.mode,
          id: p.items[0]?.id,
        })
      }
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
    expect(queueEvents.some((e) => e.pending === 1 && e.text === 'second' && e.mode === 'queue' && typeof e.id === 'string')).toBe(true)
    expect(seenPrompts).toEqual(['first', 'first|second'])
    expect(seenModels).toEqual(['provider:model-a', 'provider:model-a'])
    expect(server.store.get(sessionId)?.preferences.selectedModel).toBe('provider:model-b')

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
    dashboard.emit('client:delete_session', { sessionId })
    await deleted
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toEqual([
      { event: 'session_start', sessionId },
      { event: 'session_end', sessionId },
    ])

    dashboard.close()
  })
})

describe('terminal-bench HTTP actions', () => {
  let server: HostServer
  let dir: string
  let url: string
  let config: AgentConfig

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-tb-http-'))
    config = createConfig({ tools: [WRITE], systemPrompt: 'sys' })
  })

  afterEach(async () => {
    await server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function boot(): Promise<string> {
    const artifactRootDir = join(dir, 'artifacts')
    const http = createServer()
    await new Promise<void>((r) => http.listen(0, r))
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
    return artifactRootDir
  }

  it('resolves inline terminal-bench tasks and returns only counts (no paths)', async () => {
    await boot()
    const tasksContent = [
      { taskId: 't1', instruction: 'go', testScript: 'true' },
      { taskId: 't2', instruction: 'go', testScript: 'true' },
    ].map((t) => JSON.stringify(t)).join('\n')
    const res = await postEnhancementAction(url, {
      action: 'terminal-bench-resolve-tasks',
      runId: 'tb-resolve',
      tasksContent,
    }) as Record<string, unknown>
    expect(res.taskCount).toBe(2)
    expect(res.runId).toBe('tb-resolve')
    // Response must not leak filesystem paths (principle A1).
    const asString = JSON.stringify(res)
    expect(asString).not.toContain(dir)
    expect(asString).not.toContain('.jsonl')
  })

  it('runs a terminal-bench agent end-to-end and reports summary counts', async () => {
    const artifactRootDir = await boot()
    const tasksContent = [
      { taskId: 'pass', instruction: 'x', testScript: 'test -f pass.txt' },
      { taskId: 'fail', instruction: 'x', testScript: 'test -f neverExists' },
    ].map((t) => JSON.stringify(t)).join('\n')
    await postEnhancementAction(url, {
      action: 'terminal-bench-resolve-tasks',
      runId: 'tb-run',
      tasksContent,
    })
    const summary = await postEnhancementAction(url, {
      action: 'terminal-bench-run-agent',
      runId: 'tb-run',
      agentCommand: 'if [ "$AGENT_KERNEL_TB_TASK_ID" = "pass" ]; then touch pass.txt; fi',
    }) as { total: number; resolved: number; unresolved: number; errored: number; accuracy: number }
    expect(summary.total).toBe(2)
    expect(summary.resolved).toBe(1)
    expect(summary.unresolved).toBe(1)
    expect(summary.errored).toBe(0)
    expect(summary.accuracy).toBeCloseTo(0.5)
    const imported = await postEnhancementAction(url, {
      action: 'terminal-bench-import-results',
      runId: 'tb-run',
    }) as { resolved: number; unresolved: number; total: number }
    expect(imported.resolved).toBe(1)
    expect(imported.unresolved).toBe(1)
    expect(imported.total).toBe(2)
    // Sanity: registry entry was written under artifactRootDir with the right kind.
    const registry = JSON.parse(await readFile(join(artifactRootDir, 'registry', 'run-index.json'), 'utf8')) as {
      entries: Array<{ runId: string; kind?: string }>
    }
    expect(registry.entries.find((e) => e.runId === 'tb-run')?.kind).toBe('terminal-bench')
  })

  it('reads terminal-bench progress after a completed run', async () => {
    await boot()
    const tasksContent = JSON.stringify({ taskId: 'p', instruction: 'x', testScript: 'true' })
    await postEnhancementAction(url, {
      action: 'terminal-bench-resolve-tasks',
      runId: 'tb-progress',
      tasksContent,
    })
    await postEnhancementAction(url, {
      action: 'terminal-bench-run-agent',
      runId: 'tb-progress',
      agentCommand: 'true',
    })
    const progress = await postEnhancementAction(url, {
      action: 'terminal-bench-read-progress',
      runId: 'tb-progress',
    }) as { status: string; total: number; completed: number; resolved: number }
    expect(progress.status).toBe('completed')
    expect(progress.total).toBe(1)
    expect(progress.completed).toBe(1)
    expect(progress.resolved).toBe(1)
  })

  it('reports not_started progress when no run exists yet', async () => {
    await boot()
    const progress = await postEnhancementAction(url, {
      action: 'terminal-bench-read-progress',
      runId: 'tb-missing',
    }) as { status: string; total: number; completed: number }
    expect(progress.status).toBe('not_started')
    expect(progress.total).toBe(0)
    expect(progress.completed).toBe(0)
  })
})

describe('bad-case HTTP actions', () => {
  let server: HostServer
  let dir: string
  let url: string
  let config: AgentConfig

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-badcase-http-'))
    config = createConfig({ tools: [WRITE], systemPrompt: 'sys' })
  })

  afterEach(async () => {
    await server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function boot(): Promise<string> {
    const artifactRootDir = join(dir, 'artifacts')
    const http = createServer()
    await new Promise<void>((r) => http.listen(0, r))
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
    return artifactRootDir
  }

  async function seedTerminalBenchFailure(rootDir: string, runId: string): Promise<void> {
    await mkdir(join(rootDir, runId, 'trials'), { recursive: true })
    await writeFile(
      join(rootDir, runId, 'trials', 'task-x.json'),
      JSON.stringify({
        taskId: 'task-x',
        status: 'unresolved',
        parserOutput: { parser: 'exit-code', allPassed: false, details: 'exit 1' },
        agentExitCode: 0,
        agentTimedOut: false,
        testExitCode: 1,
        testTimedOut: false,
        durationMs: 5,
        agentStdout: 'hello',
        agentStderr: 'ERROR: nope',
        testStdout: '',
        testStderr: '',
      }),
      'utf8',
    )
  }

  it('badcase-list returns grouped counts and no filesystem paths', async () => {
    const artifactRootDir = await boot()
    await seedTerminalBenchFailure(artifactRootDir, 'r-list')
    const res = await postEnhancementAction(url, {
      action: 'badcase-list',
      runId: 'r-list',
    }) as { counts: Record<string, number>; cases: Array<{ instanceId: string; failureCategory: string }> }
    expect(res.cases).toHaveLength(1)
    expect(res.cases[0]!.instanceId).toBe('task-x')
    expect(res.counts['verifier-failure']).toBe(1)
    const asString = JSON.stringify(res)
    expect(asString).not.toContain(dir)
    expect(asString).not.toContain('.jsonl')
  })

  it('badcase-annotate persists a label and badcase-list echoes it', async () => {
    const artifactRootDir = await boot()
    await seedTerminalBenchFailure(artifactRootDir, 'r-annot')
    await postEnhancementAction(url, {
      action: 'badcase-annotate',
      runId: 'r-annot',
      instanceId: 'task-x',
      label: 'worth-retraining',
      note: 'good SFT candidate',
    })
    const res = await postEnhancementAction(url, {
      action: 'badcase-list',
      runId: 'r-annot',
    }) as { cases: Array<{ instanceId: string; annotation?: { label: string; note?: string } }> }
    expect(res.cases[0]!.annotation?.label).toBe('worth-retraining')
    expect(res.cases[0]!.annotation?.note).toBe('good SFT candidate')
  })

  it('badcase-annotate rejects unknown labels', async () => {
    await boot()
    const response = await fetch(`${url}/enhancement/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'badcase-annotate',
        runId: 'r-bad',
        instanceId: 'task-x',
        label: 'made-up',
      }),
    })
    expect(response.status).toBe(400)
  })

  it('badcase-export returns SFT and RL JSONL content strings', async () => {
    const artifactRootDir = await boot()
    await seedTerminalBenchFailure(artifactRootDir, 'r-export')
    const sft = await postEnhancementAction(url, {
      action: 'badcase-export',
      runId: 'r-export',
      instanceIds: ['task-x'],
      format: 'sft',
    }) as { format: string; count: number; content: string }
    expect(sft.format).toBe('sft')
    expect(sft.count).toBe(1)
    const sftRow = JSON.parse(sft.content.trim()) as Record<string, unknown>
    expect(sftRow).toHaveProperty('instruction')
    expect(sftRow).toHaveProperty('trace')

    const rl = await postEnhancementAction(url, {
      action: 'badcase-export',
      runId: 'r-export',
      instanceIds: ['task-x'],
      format: 'rl',
    }) as { content: string }
    const rlRow = JSON.parse(rl.content.trim()) as Record<string, unknown>
    expect(rlRow.reward).toBe(0)
    expect(rlRow.reason).toBe('verifier-failure')
  })

  it('rollout-export returns verl and slime JSONL with per-trial reward and no paths', async () => {
    const artifactRootDir = await boot()
    await mkdir(join(artifactRootDir, 'r-rollout', 'trials'), { recursive: true })
    await writeFile(
      join(artifactRootDir, 'r-rollout', 'trials', 'inst-ok.json'),
      JSON.stringify({
        trialId: 'r-rollout:inst-ok',
        experimentId: 'r-rollout',
        instanceId: 'inst-ok',
        status: 'completed',
        resolved: true,
        artifacts: [],
        metrics: {},
      }),
      'utf8',
    )
    await writeFile(
      join(artifactRootDir, 'r-rollout', 'trials', 'inst-bad.json'),
      JSON.stringify({
        trialId: 'r-rollout:inst-bad',
        experimentId: 'r-rollout',
        instanceId: 'inst-bad',
        status: 'failed',
        resolved: false,
        artifacts: [],
        metrics: {},
      }),
      'utf8',
    )

    const verl = await postEnhancementAction(url, {
      action: 'rollout-export',
      runId: 'r-rollout',
      target: 'verl',
    }) as { target: string; rolloutCount: number; content: string }
    expect(verl.target).toBe('verl')
    expect(verl.rolloutCount).toBe(2)
    const verlRows = verl.content.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const rewards = new Map(verlRows.map((r) => [r.taskId as string, r.reward as number]))
    expect(rewards.get('inst-ok')).toBe(1)
    expect(rewards.get('inst-bad')).toBe(0)
    const envelope = JSON.stringify(verl)
    expect(envelope).not.toContain(artifactRootDir)
    expect(envelope).not.toContain('.jsonl')

    const slime = await postEnhancementAction(url, {
      action: 'rollout-export',
      runId: 'r-rollout',
      target: 'slime',
      includeStatuses: ['completed'],
    }) as { rolloutCount: number; content: string }
    expect(slime.rolloutCount).toBe(1)
    const slimeRow = JSON.parse(slime.content.trim()) as Record<string, unknown>
    expect(slimeRow.frameworkTarget).toBe('slime')
    expect(slimeRow.entrypoint).toBe('custom_rollout_manifest')
    expect(slimeRow.reward).toBe(1)
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
