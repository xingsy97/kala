/**
 * Socket.IO client that connects to the host's `/executor` namespace, announces
 * the local tool set, and services `tool:call` events by dispatching them to
 * the local tool registry.
 *
 * Every in-flight call gets its own `AbortController`; `tool:cancel` from host
 * aborts it. Tool failures become `{ ok: false, content: 'ERROR: …' }` — we
 * never let a runner exception cross the wire.
 *
 * Filesystem RPC handlers (list_dirs / list_files / read_file) live in
 * `./fs-handlers.ts`; machine metadata (os / ip list) lives in
 * `./announce-info.ts`. Both are pure and independently testable.
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
import { loadOrCreateWorkspaceId } from './workspace-id.js'
import { collectIpAddresses, normalizeOs } from './announce-info.js'
import { listDirs, listFiles, readWorkspaceFile } from './fs-handlers.js'

export type ExecutorOptions = {
  /** Host URL (e.g. `wss://host.example.com` or `http://localhost:3000`). */
  host: string
  /**
   * Stable workspace identity. If omitted, the executor loads (or on first
   * launch mints) one from `~/.agent-kernel/workspace-id`. Passing this
   * explicitly is the escape hatch for tests or multi-tenant deployments.
   */
  workspaceId?: string
  /**
   * Display label for the workspace (a workspace = a machine). Free to
   * rename — routing goes by workspaceId, not this. If omitted,
   * `os.hostname()` is used.
   */
  workspaceName?: string
  /**
   * Optional filesystem jail. Empty / omitted = executor trusts the whole
   * machine (defers to OS user permissions). Passing one or more roots
   * restricts file tools to those subtrees.
   */
  sandboxRoots?: readonly string[]
  token?: string
  executorId?: string
  tools?: readonly Tool[]
  /** Injectable Socket.IO factory — used by tests. */
  ioFactory?: typeof clientIO
}

export type ExecutorHandle = {
  readonly executorId: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly socket: Socket<
    ExecutorServerToClientEvents,
    ExecutorClientToServerEvents
  >
  readonly ready: Promise<void>
  close(): void
}

export function startExecutor(options: ExecutorOptions): ExecutorHandle {
  const sandboxRoots = options.sandboxRoots ?? []
  const sandbox: Sandbox = createSandbox({ roots: sandboxRoots })
  const tools = createToolRegistry(options.tools ?? defaultTools)
  const executorId = options.executorId ?? ulid()
  const workspaceId = options.workspaceId ?? loadOrCreateWorkspaceId()
  const workspaceName = options.workspaceName ?? hostname()

  const factory = options.ioFactory ?? clientIO
  const socket = factory(`${options.host}/executor`, {
    transports: ['websocket'],
    auth: {
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
    executorId,
    workspaceId,
    workspaceName,
    tools: [...tools.keys()],
    ...(sandboxRoots.length > 0 ? { sandboxRoots: [...sandboxRoots] } : {}),
    runtime: 'node',
    runtimeVersion: process.version,
    hostname: hostname(),
    os: normalizeOs(platform()),
    ipAddresses: collectIpAddresses(),
    pid: process.pid,
    startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
  }

  const ready = new Promise<void>((resolve) => {
    socket.on('connect', () => {
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

  socket.on('fs:list_dirs', async (payload, ack) => {
    ack(await listDirs(payload.requestId, payload.workspaceId, payload.path, sandbox))
  })

  socket.on('fs:list_files', async (payload, ack) => {
    ack(await listFiles(payload, sandbox))
  })

  socket.on('fs:read_file', async (payload, ack) => {
    ack(await readWorkspaceFile(payload, sandbox))
  })

  return {
    executorId,
    workspaceId,
    workspaceName,
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
    const content = await tool.run(payload.input, {
      sandbox,
      signal,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
    })
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
