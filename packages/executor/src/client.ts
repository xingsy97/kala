/**
 * Socket.IO client that connects to the host's `/executor` namespace, announces
 * the local tool set, and services `tool:call` events by dispatching them to
 * the local tool registry.
 *
 * Every in-flight call gets its own `AbortController`; `tool:cancel` from host
 * aborts it. Tool failures become `{ ok: false, content: 'ERROR: …' }` — we
 * never let a runner exception cross the wire.
 */

import { hostname, platform } from 'node:os'
import process from 'node:process'

import type {
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ToolCallMessage,
  ToolCancelMessage,
  ToolResultAck,
} from '@agent-kernel/shared'
import { io as clientIO, type Socket } from 'socket.io-client'
import { ulid } from 'ulid'

import { createSandbox } from './sandbox.js'
import type { Sandbox } from './sandbox.js'
import { allTools as defaultTools } from './tools/index.js'
import type { Tool } from './tools/registry.js'
import { ToolError, createToolRegistry } from './tools/registry.js'

export type ExecutorOptions = {
  /** Host URL (e.g. `wss://host.example.com` or `http://localhost:3000`). */
  host: string
  sessionId: string
  workspace: string | readonly string[]
  token?: string
  executorId?: string
  tools?: readonly Tool[]
  /** Injectable Socket.IO factory — used by tests. */
  ioFactory?: typeof clientIO
}

export type ExecutorHandle = {
  readonly executorId: string
  readonly socket: Socket<
    ExecutorServerToClientEvents,
    ExecutorClientToServerEvents
  >
  readonly ready: Promise<void>
  close(): void
}

export function startExecutor(options: ExecutorOptions): ExecutorHandle {
  const workspaces = Array.isArray(options.workspace)
    ? options.workspace
    : [options.workspace as string]
  const sandbox: Sandbox = createSandbox({ roots: workspaces })
  const tools = createToolRegistry(options.tools ?? defaultTools)
  const executorId = options.executorId ?? ulid()

  const factory = options.ioFactory ?? clientIO
  const socket = factory(`${options.host}/executor`, {
    transports: ['websocket'],
    auth: {
      sessionId: options.sessionId,
      role: 'executor',
      clientVersion: '0.0.0',
      ...(options.token !== undefined ? { token: options.token } : {}),
    },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  }) as Socket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>

  const inFlight = new Map<string, AbortController>()

  const announcement: ExecutorAnnounce = {
    sessionId: options.sessionId,
    executorId,
    tools: [...tools.keys()],
    workingDir: workspaces[0]!,
    runtime: 'node',
    runtimeVersion: process.version,
  }

  const ready = new Promise<void>((resolve) => {
    socket.on('session:ready', () => {
      socket.emit('executor:announce', announcement)
      resolve()
    })
  })

  socket.on('tool:call', async (payload: ToolCallMessage, ack) => {
    const controller = new AbortController()
    inFlight.set(payload.callId, controller)
    const result = await runOne(tools, sandbox, controller.signal, payload)
    inFlight.delete(payload.callId)
    ack(result)
    socket.emit('executor:tool_result', {
      sessionId: payload.sessionId,
      callId: payload.callId,
      ok: result.ok,
      content: result.content,
    })
  })

  socket.on('tool:cancel', (payload: ToolCancelMessage) => {
    const ctrl = inFlight.get(payload.callId)
    if (ctrl) ctrl.abort()
  })

  return {
    executorId,
    socket,
    ready,
    close() {
      for (const c of inFlight.values()) c.abort()
      inFlight.clear()
      socket.disconnect()
    },
  }
}

async function runOne(
  tools: Map<string, Tool>,
  sandbox: Sandbox,
  signal: AbortSignal,
  payload: ToolCallMessage,
): Promise<ToolResultAck> {
  const tool = tools.get(payload.name)
  if (!tool) {
    return {
      callId: payload.callId,
      ok: false,
      content: `ERROR: EINVAL: unknown tool: ${payload.name}`,
    }
  }
  try {
    const content = await tool.run(payload.input, { sandbox, signal })
    return { callId: payload.callId, ok: true, content }
  } catch (err) {
    if (err instanceof ToolError) {
      return {
        callId: payload.callId,
        ok: false,
        content: `ERROR: ${err.message}`,
      }
    }
    return {
      callId: payload.callId,
      ok: false,
      content: `ERROR: EIO: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

void hostname
void platform
