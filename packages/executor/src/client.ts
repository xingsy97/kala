/**
 * Socket.IO client that connects to the host's `/executor` namespace, announces
 * the local tool set, and services `tool:call` events by dispatching them to
 * the local tool registry.
 *
 * Every in-flight call gets its own `AbortController`; `tool:cancel` from host
 * aborts it. Tool failures become `{ ok: false, content: 'ERROR:  - ' }`  -  we
 * never let a runner exception cross the wire.
 *
 * Filesystem RPC handlers (list_dirs / list_files / read_file) live in
 * `./fs-handlers.ts`; machine metadata (os / ip list) lives in
 * `./announce-info.ts`. Both are pure and independently testable.
 */

import { hostname, platform } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import type {
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorServerToClientEvents,
  ToolCallMessage,
  ToolCancelMessage,
  ToolResultAck,
} from '@agent-kernel/shared'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { io as clientIO, type Socket } from 'socket.io-client'
import { ulid } from 'ulid'

import { createSandbox } from './sandbox.js'
import type { Sandbox } from './sandbox.js'
import { allTools as defaultTools } from './tools/index.js'
import type { Tool } from './tools/registry.js'
import { ToolError, createToolRegistry } from './tools/registry.js'
import {
  maybeOverflow,
  overflowConfigFromEnv,
  type OverflowConfig,
} from './tools/overflow.js'
import { loadOrCreateWorkspaceId } from './workspace-id.js'
import { collectIpAddresses, normalizeOs } from './announce-info.js'
import { subscribeBackgroundTasks } from './tools/background-shell.js'

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
   * rename  -  routing goes by workspaceId, not this. If omitted,
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
  invite?: string
  executorId?: string
  onToken?(token: string): void
  tools?: readonly Tool[]
  /** Injectable Socket.IO factory  -  used by tests. */
  ioFactory?: typeof clientIO
}

export type PermanentError = {
  code: 'workspace_id_conflict' | 'workspace_identity_mismatch' | 'version_incompatible' | 'auth_failed' | 'reconnect_exhausted'
  message: string
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
  /**
   * Resolves when the executor decides to give up reconnecting  -  either the
   * host emitted `executor:host_reject`, a `connect_error` reported an
   * unrecoverable message, or socket.io exhausted its retry budget. The
   * CLI wrapper awaits this so it can exit with a distinct code per
   * failure class; embedders (tests) awaits it to detect fatal state.
   * Never resolves during normal operation.
   */
  readonly permanentError: Promise<PermanentError>
  close(): void
}

export function startExecutor(options: ExecutorOptions): ExecutorHandle {
  const sandboxRoots = options.sandboxRoots ?? []
  const sandbox: Sandbox = createSandbox({ roots: sandboxRoots })
  const tools = createToolRegistry(options.tools ?? defaultTools)
  const executorId = options.executorId ?? ulid()
  const workspaceId = options.workspaceId ?? loadOrCreateWorkspaceId()
  const workspaceName = options.workspaceName ?? hostname()
  const workspaceRoot = sandboxRoots[0] ?? process.cwd()
  const overflowConfig = overflowConfigFromEnv(
    join(workspaceRoot, '.agent-kernel', 'overflow'),
  )

  const factory = options.ioFactory ?? clientIO
  const socket = factory(`${options.host}/executor`, {
    transports: ['websocket'],
    auth: {
      role: 'executor',
      clientVersion: PROTOCOL_VERSION,
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.invite !== undefined ? { invite: options.invite } : {}),
    },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 30_000,   // socket.io does exponential backoff up to this
    reconnectionAttempts: 30,       // stop trying after ~15min of the max delay
    randomizationFactor: 0.5,       //  - 50% jitter, avoid thundering-herd reconnect
  }) as Socket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>

  const inFlight = new Map<string, AbortController>()
  // Idempotency cache: remember the last N completed tool calls so a
  // duplicate `tool:call` (from `redispatchPending` on the host after a
  // reconnect) does not re-run a tool that already succeeded. LRU-lite:
  // insertion order via Map; when full, drop the oldest entry.
  const COMPLETED_CALL_CACHE_MAX = 500
  const completedCalls = new Map<string, ToolResultAck>()
  const rememberCompleted = (callId: string, ack: ToolResultAck): void => {
    completedCalls.set(callId, ack)
    while (completedCalls.size > COMPLETED_CALL_CACHE_MAX) {
      const oldest = completedCalls.keys().next().value
      if (oldest === undefined) break
      completedCalls.delete(oldest)
    }
  }

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

  // Permanent-error latch. Any handler that discovers we cannot recover
  // resolves this once  -  the CLI awaits it to exit with a specific code.
  let permanentErrorResolver: ((e: PermanentError) => void) | null = null
  const permanentError = new Promise<PermanentError>((resolve) => {
    permanentErrorResolver = resolve
  })
  const givePermanentError = (e: PermanentError): void => {
    if (permanentErrorResolver) {
      permanentErrorResolver(e)
      permanentErrorResolver = null
    }
    // Kill socket.io's own retry loop; otherwise it will keep dialing on a
    // situation the caller has already decided is unrecoverable.
    socket.disconnect()
  }

  // Host-initiated permanent rejects (workspaceId conflict, wrong version,
  // bad auth). Server emits `executor:host_reject` immediately before it
  // calls `socket.disconnect(true)`, so we route the code + message into
  // the permanent-error latch.
  socket.on('executor:host_reject', (payload) => {
    givePermanentError({ code: payload.code, message: payload.message })
  })

  socket.on('executor:welcome', (payload) => {
    options.onToken?.(payload.token)
    socket.auth = {
      role: 'executor',
      clientVersion: PROTOCOL_VERSION,
      token: payload.token,
    }
  })

  // Handshake failures (auth, version). These come through connect_error
  // with the error's `.message` being the reason middleware called
  // `next(new Error(reason))` on the host side.
  socket.on('connect_error', (err) => {
    const msg = (err as Error).message || String(err)
    if (msg === 'version_incompatible') {
      givePermanentError({ code: 'version_incompatible', message: msg })
    } else if (msg === 'auth_failed') {
      givePermanentError({ code: 'auth_failed', message: msg })
    }
    // Other connect_errors (network transient, DNS, host down) are
    // recoverable  -  let socket.io keep retrying.
  })

  // Socket.io exhausted its `reconnectionAttempts` budget without ever
  // reconnecting. The user's network is genuinely unreachable; wait for
  // them.
  socket.io.on('reconnect_failed', () => {
    givePermanentError({
      code: 'reconnect_exhausted',
      message: 'exhausted reconnection attempts',
    })
  })

  socket.on('tool:call', async (payload: ToolCallMessage, ack) => {
    // Idempotency: two paths can send us the same callId  -  the normal LLM
    // path via kernel `call_tool`, and `redispatchPending` on the host
    // side when the socket reconnects. If we already ran this call, don't
    // run it again; ack with the cached result.
    const cached = completedCalls.get(payload.callId)
    if (cached) {
      ack(cached)
      return
    }
    // Already running: the original promise chain will ack when done.
    // Ignore the duplicate emit.
    if (inFlight.has(payload.callId)) return

    const controller = new AbortController()
    inFlight.set(payload.callId, controller)
    const result = await runOne(tools, sandbox, controller.signal, payload, overflowConfig)
    inFlight.delete(payload.callId)
    rememberCompleted(payload.callId, result)
    ack(result)
  })

  socket.on('tool:cancel', (payload: ToolCancelMessage) => {
    const ctrl = inFlight.get(payload.callId)
    if (ctrl) ctrl.abort()
  })

  // Host-internal filesystem/background RPCs also arrive as ordinary
  // `tool:call` messages. The executor executes tools only; the host decides
  // whether the result enters the agent transcript or returns to a dashboard RPC.

  const unsubscribeBg = subscribeBackgroundTasks((change) => {
    if (change.kind === 'evicted') {
      socket.emit('executor:bg_task_evicted', {
        workspaceId,
        sessionId: change.sessionId,
        taskId: change.taskId,
      })
      return
    }
    socket.emit('executor:bg_task_updated', {
      workspaceId,
      sessionId: change.task.sessionId,
      task: change.task,
      ...(change.kind === 'output' ? { delta: change.delta } : {}),
    })
  })

  return {
    executorId,
    workspaceId,
    workspaceName,
    socket,
    ready,
    permanentError,
    close() {
      unsubscribeBg()
      for (const c of inFlight.values()) c.abort()
      inFlight.clear()
      socket.disconnect()
    },
  }
}

const OVERFLOW_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'todowrite',
  'memory',
  'bash_output',
])

async function runOne(
  tools: Map<string, Tool>,
  sandbox: Sandbox,
  signal: AbortSignal,
  payload: ToolCallMessage,
  overflowConfig: OverflowConfig,
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
      sessionId: payload.sessionId,
      sandbox,
      signal,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
    })
    if (OVERFLOW_EXEMPT_TOOLS.has(payload.name)) {
      return { callId: payload.callId, ok: true, content }
    }
    const overflow = await maybeOverflow(content, {
      sessionId: payload.sessionId,
      callId: payload.callId,
      config: overflowConfig,
    })
    return { callId: payload.callId, ok: true, content: overflow.content }
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
