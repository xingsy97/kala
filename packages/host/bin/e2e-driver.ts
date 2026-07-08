/**
 * Task #62 e2e driver. Boots host + executor with a scripted (no-API-key)
 * LLM so we can verify the dashboard UI in a real headless browser.
 *
 * Steps:
 *   1. Start host on :3111 with an ephemeral sessionsDir.
 *   2. Start executor pointed at host, waits for `session:ready`.
 *   3. Drive one dashboard user_message → LLM tool_call → tool_result → done
 *      round-trip so the JSONL log has real content (4 events).
 *   4. Print the sessionId + port + workspaceDir, then keep listening for
 *      SIGINT so the browser can attach.
 *
 * Kill with SIGINT once the browser check is done.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import type { LLMAdapter } from '../src/llm/adapter.js'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { startHostServer } from '../src/server.js'
import { startExecutor } from '../../executor/src/client.js'

const SESSION_ID = 'e2e-session'
const HOST_PORT = 3111
const WORKSPACE = mkdtempSync(join(tmpdir(), 'e2e-workspace-'))
const SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'e2e-sessions-'))

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
            input: { path: 'hello.txt', content: 'hello from e2e' },
          },
        ],
      },
    },
    {
      message: {
        role: 'assistant' as const,
        content: [
          {
            type: 'text' as const,
            text: 'Wrote hello.txt with a friendly greeting.',
          },
        ],
      },
    },
  ]
  return {
    name: 'e2e-scripted',
    async call() {
      const next = queue.shift()
      if (!next) throw new Error('scripted LLM exhausted')
      return next
    },
  }
}

async function main(): Promise<void> {
  const server = await startHostServer({
    port: HOST_PORT,
    sessionsDir: SESSIONS_DIR,
    llm: scriptedLlm(),
    defaultConfig: {
      tools: [
        {
          name: 'write',
          description: 'write a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
          requiresApproval: false,
        },
      ],
      systemPrompt: 'e2e system prompt',
    },
    toolTimeoutMs: 5000,
  })

  // Dashboard connects FIRST so the host ensure()s the session on disk
  // before the executor tries to attach. Executors are pure RPC responders
  // in v1 and get bounced with `unknown_session` if the session doesn't
  // exist yet (server.ts:451).
  const { io } = await import('socket.io-client')
  const dashboardSocket = io(`http://localhost:${server.port}/dashboard`, {
    transports: ['websocket'],
    auth: {
      sessionId: SESSION_ID,
      role: 'dashboard',
      clientVersion: PROTOCOL_VERSION,
    },
    reconnection: false,
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dashboard ready timeout')), 5000)
    dashboardSocket.on('connect_error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    dashboardSocket.on('session:ready', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  const executor = startExecutor({
    host: `http://localhost:${server.port}`,
    sessionId: SESSION_ID,
    workspace: WORKSPACE,
  })
  await executor.ready

  console.log(
    JSON.stringify({
      event: 'ready',
      port: server.port,
      sessionId: SESSION_ID,
      workspace: WORKSPACE,
      sessionsDir: SESSIONS_DIR,
      executorId: executor.executorId,
    }),
  )

  // Drive one round-trip on the dashboard socket so the JSONL log has a
  // real user_message → tool_call → tool_result → done timeline.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never reached done')), 8000)
    dashboardSocket.on('state:changed', (payload: { state: { status: string } }) => {
      if (payload.state.status === 'done') {
        clearTimeout(timer)
        resolve()
      }
      if (payload.state.status === 'error') {
        clearTimeout(timer)
        reject(new Error('kernel error'))
      }
    })
    dashboardSocket.emit('client:user_message', {
      sessionId: SESSION_ID,
      text: 'please write hello.txt',
    })
  })
  dashboardSocket.close()
  console.log(JSON.stringify({ event: 'seeded', sessionId: SESSION_ID }))

  const shutdown = async (): Promise<void> => {
    executor.close()
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
