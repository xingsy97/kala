import { mkdtempSync, rmSync } from 'node:fs'
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
  ServerSessionsPayload,
  ServerSubAgentFinishedEvent,
  ServerSubAgentStartedEvent,
  SessionForkedEvent,
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
  // Direct-mode tool calls (host-initiated fs / bg / overflow RPCs) arrive
  // as `tool:call` with `dispatchMode: 'direct'`. The stub executor here
  // pretends to be the `__fs_list_dirs` built-in and returns a JSON string
  // matching DirListResult.
  executor.on('tool:call', (payload, ack: (result: ToolResultAck) => void) => {
    if (payload.dispatchMode !== 'direct' || payload.name !== '__fs_list_dirs') return
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
      auth: { sessionId: 's', role: 'executor', clientVersion: PROTOCOL_VERSION },
      reconnection: false,
    })
    const err = await new Promise<Error>((resolve) => {
      bad.on('connect_error', (e) => resolve(e))
    })
    expect(err.message).toBe('role_mismatch')
    bad.close()
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
    }).then((r) => r.json() as Promise<{ planPath: string; selectedCount: number; shardCount: number }>)

    expect(response.selectedCount).toBe(2)
    expect(response.shardCount).toBe(2)
    expect(response.planPath).toBe(join(artifactRootDir, 'dash-plan', 'worker-plan.json'))

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
    expect(grade.command).toContain(exported.predictionsPath)
    expect(grade.shellCommand).toContain('dash-export')

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
    expect(grade.shellCommand).toContain('/tmp/predictions.jsonl')
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
    expect(forkedRec?.state.sessionId).toBe('wire-fork-child')
    expect(forkedRec?.parentSessionId).toBe(sessionId)
    expect(forkedRec?.parentCursor).toBe(2)
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
        if (call === 2) {
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
      dashboard.once('server:sub_agent_started', resolve)
    })
    const finished = new Promise<ServerSubAgentFinishedEvent>((resolve) => {
      dashboard.once('server:sub_agent_finished', resolve)
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
      auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
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
      auth: { role: 'executor', clientVersion: PROTOCOL_VERSION },
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
      if (payload.dispatchMode !== 'direct' || payload.name !== '__fs_list_dirs') return
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
        name: 'queue-test',
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
            usage: { inputTokens: 10, outputTokens: 1 },
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
    releaseFirst()
    await finalDone

    expect(queueEvents.map((e) => e.pending)).toContain(1)
    expect(queueEvents.map((e) => e.pending)).toContain(0)
    expect(queueEvents.some((e) => e.pending === 1 && e.text === 'second' && e.mode === 'queue' && typeof e.id === 'string')).toBe(true)
    expect(seenPrompts).toEqual(['first', 'first|second'])

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
