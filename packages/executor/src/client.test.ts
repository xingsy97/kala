import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ulid } from 'ulid'

import { createConfig } from '@agent-kernel/kernel'
import type { AgentConfig, Message } from '@agent-kernel/kernel'
import { startHostServer, type HostServer } from '@agent-kernel/host'
import type { LLMAdapter } from '@agent-kernel/host'
import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  SessionReadyEvent,
} from '@agent-kernel/shared'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { io as clientIO, type Socket as ClientSocket } from 'socket.io-client'

import { startExecutor } from './client.js'

function scriptedLlm(targetPath: string): LLMAdapter {
  return scriptedMessages([
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_call' as const,
          callId: 'c1',
          name: 'write',
          input: { path: targetPath, content: 'from-llm' },
        },
      ],
    },
    {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'done' }],
    },
  ])
}

function scriptedMessages(messages: Message[]): LLMAdapter {
  const queue = [
    ...messages.map((message) => ({ message })),
  ]
  return {
    name: 'scripted',
    async call() {
      const next = queue.shift()
      if (!next) throw new Error('llm exhausted')
      return next
    },
  }
}

const WRITE_SCHEMA = {
  name: 'write',
  description: 'write a file',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

const LS_SCHEMA = {
  name: 'ls',
  description: 'list files',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

const BASH_SCHEMA = {
  name: 'bash',
  description: 'run bash',
  inputSchema: { type: 'object' },
  requiresApproval: false,
} as const

async function waitForDone(
  dashboard: ClientSocket<DashboardServerToClientEvents, DashboardClientToServerEvents>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never done')), 5000)
    dashboard.on('state:changed', (p) => {
      if (p.state.status === 'done') {
        clearTimeout(timer)
        resolve()
      }
      if (p.state.status === 'error') {
        clearTimeout(timer)
        reject(new Error('kernel error: ' + p.state.error))
      }
    })
  })
}

function toolResultContent(logPath: string, callId: string): string | undefined {
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  for (const line of lines) {
    const parsed = JSON.parse(line) as {
      kind: string
      event?: { kind: string; callId?: string; content?: string }
    }
    if (
      parsed.kind === 'event' &&
      parsed.event?.kind === 'tool_result' &&
      parsed.event.callId === callId
    ) {
      return parsed.event.content
    }
  }
  return undefined
}

describe('executor end-to-end', () => {
  let server: HostServer
  let sessionsDir: string
  let sandboxRoot: string
  let url: string
  let config: AgentConfig
  let targetPath: string

  beforeEach(async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'ak-e2e-sess-'))
    sandboxRoot = mkdtempSync(join(tmpdir(), 'ak-e2e-ws-'))
    targetPath = join(sandboxRoot, 'hello.txt')
    config = createConfig({ tools: [WRITE_SCHEMA], systemPrompt: 'sys' })
    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir,
      llm: scriptedLlm(targetPath),
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 3000,
    })
    url = `http://localhost:${server.port}`
  })

  afterEach(async () => {
    await server.close()
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(sandboxRoot, { recursive: true, force: true })
  })

  it('runs a real tool call through the wire and writes to disk', async () => {
    const sessionId = 'e2e-1'
    const workspaceId = ulid()
    // Dashboard handshakes no longer materialize the session on disk — that
    // is deferred until the first dispatch. Pre-materialize so the executor
    // has something to attach to when it dials in.
    await server.store.ensure({
      sessionId,
      defaultConfig: config,
      workspaceId,
      workspaceName: 'test-ws',
    })

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

    const executor = startExecutor({
      host: url,
      workspaceId,
      workspaceName: 'test-ws',
      sandboxRoots: [sandboxRoot],
    })
    await executor.ready

    // Wait until host has registered the executor before we send the message.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now()
      const tick = (): void => {
        const anyReg = server.io.of('/executor').sockets.size > 0
        if (anyReg) return resolve()
        if (Date.now() - start > 2000)
          return reject(new Error('executor announce wait timeout'))
        setTimeout(tick, 10)
      }
      tick()
    })

    dashboard.emit('client:user_message', {
      sessionId,
      text: 'please write',
    })

    await waitForDone(dashboard)

    expect(existsSync(targetPath)).toBe(true)
    expect(readFileSync(targetPath, 'utf8')).toBe('from-llm')

    dashboard.close()
    executor.close()
  })

  it('honors session cwd for real ls and bash tool calls', async () => {
    await server.close()

    const sessionId = 'e2e-cwd'
    const workspaceId = ulid()
    const child = join(sandboxRoot, 'child')
    mkdirSync(child)
    writeFileSync(join(sandboxRoot, 'root-only.txt'), '')
    writeFileSync(join(child, 'child-only.txt'), '')
    config = createConfig({ tools: [LS_SCHEMA, BASH_SCHEMA], systemPrompt: 'sys' })

    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir,
      llm: scriptedMessages([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'ls-cwd',
              name: 'ls',
              input: { path: '.', hidden: true },
            },
            {
              type: 'tool_call',
              callId: 'pwd-cwd',
              name: 'bash',
              input: { command: 'pwd' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      ]),
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 3000,
    })
    url = `http://localhost:${server.port}`

    await server.store.ensure({
      sessionId,
      defaultConfig: config,
      workspaceId,
      workspaceName: 'test-ws',
      initialCwd: child,
    })

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

    const executor = startExecutor({
      host: url,
      workspaceId,
      workspaceName: 'test-ws',
      sandboxRoots: [sandboxRoot],
    })
    await executor.ready

    dashboard.emit('client:user_message', {
      sessionId,
      text: 'show cwd',
    })

    await waitForDone(dashboard)

    const rec = server.store.get(sessionId)!
    expect(toolResultContent(rec.logPath, 'ls-cwd')).toBe('child-only.txt')
    const pwd = toolResultContent(rec.logPath, 'pwd-cwd')
    expect(pwd?.split('\n')[0]).toBe(child)
    expect(pwd).not.toContain(sandboxRoot + '\n--- exit code')

    dashboard.close()
    executor.close()
  })

  it('honors cwd changed through the dashboard before running bash pwd', async () => {
    await server.close()

    const sessionId = 'e2e-set-cwd-pwd'
    const workspaceId = ulid()
    const child = join(sandboxRoot, 'tmp-like-child')
    mkdirSync(child)
    config = createConfig({ tools: [BASH_SCHEMA], systemPrompt: 'sys' })

    const http = createServer()
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as AddressInfo).port
    server = await startHostServer({
      port,
      sessionsDir,
      llm: scriptedMessages([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              callId: 'pwd-after-set-cwd',
              name: 'bash',
              input: { command: 'pwd' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      ]),
      defaultConfig: config,
      httpServer: http,
      toolTimeoutMs: 3000,
    })
    url = `http://localhost:${server.port}`

    await server.store.ensure({
      sessionId,
      defaultConfig: config,
      workspaceId,
      workspaceName: 'test-ws',
    })

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

    const executor = startExecutor({
      host: url,
      workspaceId,
      workspaceName: 'test-ws',
      sandboxRoots: [sandboxRoot],
    })
    await executor.ready

    const cwdChanged = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cwd never changed')), 3000)
      dashboard.on('state:changed', (p) => {
        if (p.state.cwd === child) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    dashboard.emit('client:set_cwd', { sessionId, cwd: child })
    await cwdChanged
    expect(server.store.get(sessionId)?.state.cwd).toBe(child)

    dashboard.emit('client:user_message', {
      sessionId,
      text: 'what is pwd',
    })
    await waitForDone(dashboard)

    const rec = server.store.get(sessionId)!
    const pwd = toolResultContent(rec.logPath, 'pwd-after-set-cwd')
    expect(pwd?.split('\n')[0]).toBe(child)
    expect(pwd).not.toContain(process.cwd())

    dashboard.close()
    executor.close()
  })
})
