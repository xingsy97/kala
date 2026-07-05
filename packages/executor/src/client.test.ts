import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ulid } from 'ulid'

import { createConfig } from '@agent-kernel/kernel'
import type { AgentConfig } from '@agent-kernel/kernel'
import { startHostServer, type HostServer } from '@agent-kernel/host'
import type { LLMAdapter } from '@agent-kernel/host'
import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  SessionReadyEvent,
} from '@agent-kernel/shared'
import { io as clientIO, type Socket as ClientSocket } from 'socket.io-client'

import { startExecutor } from './client.js'

function scriptedLlm(targetPath: string): LLMAdapter {
  const queue = [
    {
      message: {
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
    },
    {
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'done' }],
      },
    },
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
    // Dashboard handshakes no longer materialize the session on disk  -  that
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
      auth: { sessionId, role: 'dashboard', clientVersion: '0.0.0' },
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

    const done = new Promise<void>((resolve, reject) => {
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

    dashboard.emit('client:user_message', {
      sessionId,
      text: 'please write',
    })

    await done

    expect(existsSync(targetPath)).toBe(true)
    expect(readFileSync(targetPath, 'utf8')).toBe('from-llm')

    dashboard.close()
    executor.close()
  })
})
