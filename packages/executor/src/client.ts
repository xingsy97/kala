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
import { join } from 'node:path'
import process from 'node:process'

import type {
  BuildMetadata,
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
import { createTerminalManager } from './terminal-manager.js'
import { ExecutionReceiptStore } from './execution-receipts.js'
import type { RuntimeLogger } from './logger.js'
import { executorReleaseVersion } from './build-info.js'
import { failureForToolError } from './tool-failure.js'

const noopLogger: Pick<RuntimeLogger, 'debug' | 'info' | 'warn'> = {
  debug() {},
  info() {},
  warn() {},
}

const SENSITIVE_KEY = /(?:password|passwd|token|api[_-]?key|secret|authorization|cookie|credential|private[_-]?key|setup[_-]?code)/iu
const LARGE_VALUE_KEY = /^(?:content|patch|stdin|oldText|newText)$/u
const LOG_STRING_LIMIT = 500
const CONNECTION_ERROR_LIMIT = 300
const CONNECTION_DIAGNOSTIC_LIMIT = 1_500

function compactLogText(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function connectionErrorSummary(error: unknown): { errorType: string; reason: string; code?: string | number } {
  const value = error as { name?: unknown; type?: unknown; message?: unknown; description?: unknown; code?: unknown }
  const description = value?.description as { message?: unknown; code?: unknown } | undefined
  const innerReason = description && typeof description === 'object' ? description.message : description
  const outerReason = value?.message ?? error
  const reason = compactLogText(innerReason || outerReason || 'unknown connection error', CONNECTION_ERROR_LIMIT)
  const errorType = compactLogText(value?.type || value?.name || 'ConnectionError', 80)
  const code = description && typeof description === 'object' ? description.code : value?.code
  return { errorType, reason, ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}) }
}

function compactDiagnostic(error: unknown): string {
  const value = error as { stack?: unknown; message?: unknown }
  return compactLogText(value?.stack || value?.message || error, CONNECTION_DIAGNOSTIC_LIMIT)
}

function safeToolInput(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (depth > 4) return '[TRUNCATED depth]'
  if (typeof value === 'string') {
    const scrubbed = value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
      .replace(/(https?:\/\/[^\s/:]+:)[^@\s]+@/giu, '$1[REDACTED]@')
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    if (LARGE_VALUE_KEY.test(key) || scrubbed.length > LOG_STRING_LIMIT) {
      return `${scrubbed.slice(0, LOG_STRING_LIMIT)}… [TRUNCATED ${scrubbed.length} chars]`
    }
    return scrubbed
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeToolInput(item, key, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([childKey, child]) => [childKey, safeToolInput(child, childKey, depth + 1)]))
  }
  return value
}

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
  invite?: string
  executorId?: string
  installId?: string
  onToken?(token: string): void
  tools?: readonly Tool[]
  logger?: Pick<RuntimeLogger, 'debug' | 'info' | 'warn'>
  /** Injectable Socket.IO factory — used by tests. */
  ioFactory?: typeof clientIO
  receiptStorePath?: string | false
  networkPolicy?: import('@agent-kernel/shared').NetworkPolicy
}

export type PermanentError = {
  code: 'workspace_id_conflict' | 'workspace_identity_mismatch' | 'version_incompatible' | 'auth_failed'
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
   * Resolves when the executor decides to give up reconnecting — either the
   * host emitted `executor:host_reject`, a `connect_error` reported an
   * unrecoverable message. Transient transport failures never resolve this;
   * the executor is a daemon and keeps reconnecting until it is explicitly
   * stopped or the host rejects its identity/auth/version.
   * Never resolves during normal operation.
   */
  readonly permanentError: Promise<PermanentError>
  readonly activeToolCount: () => number
  readonly activeTerminalCount: () => number
  readonly draining: () => boolean
  beginDrain(): void
  resume(): void
  close(): void
}

export function startExecutor(options: ExecutorOptions): ExecutorHandle {
  const logger = options.logger ?? noopLogger
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
  const receiptStore = options.receiptStorePath === false
    ? null
    : new ExecutionReceiptStore(options.receiptStorePath ?? join(workspaceRoot, '.agent-kernel', 'execution-receipts.json'))
  const receiptStoreReady = receiptStore?.load() ?? Promise.resolve()

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
    reconnectionDelayMax: 60_000,   // keep recovery bounded while retaining jitter
    reconnectionAttempts: Infinity,
    randomizationFactor: 0.5,       // +/-50% jitter, avoid thundering-herd reconnect
    ...(options.invite ? { extraHeaders: { 'x-agent-runlab-executor-invite': options.invite } } : {})
  }) as Socket<ExecutorServerToClientEvents, ExecutorClientToServerEvents>

  const inFlight = new Map<string, AbortController>()
  let drainRequested = false
  // A reconnect can redispatch a callId while the original invocation is still
  // running. Keep every socket ACK callback so completion reaches whichever
  // socket the host currently tracks instead of being stranded on the old one.
  const inFlightAcks = new Map<string, Array<(result: ToolResultAck) => void>>()
  // Idempotency cache: remember the last N completed tool calls so a
  // duplicate `tool:call` (from `redispatchPending` on the host after a
  // reconnect) does not re-run a tool that already succeeded. LRU-lite:
  // insertion order via Map; when full, drop the oldest entry.
  const COMPLETED_CALL_CACHE_MAX = 500
  const completedCalls = new Map<string, ToolResultAck>()
  const receiptKey = (sessionId: string, callId: string): string => `${sessionId}:${callId}`
  const rememberCompleted = (key: string, ack: ToolResultAck): void => {
    completedCalls.set(key, ack)
    while (completedCalls.size > COMPLETED_CALL_CACHE_MAX) {
      const oldest = completedCalls.keys().next().value
      if (oldest === undefined) break
      completedCalls.delete(oldest)
    }
  }

  const announcement: ExecutorAnnounce = {
    executorId,
    ...(options.installId ? { installId: options.installId } : {}),
    executorVersion: executorReleaseVersion(),
    build: executorBuildInfo(),
    capabilities: executorCapabilities(tools, sandboxRoots),
    workspaceId,
    workspaceName,
    tools: [...tools.keys()],
    toolImplementations: Object.fromEntries([...tools.keys()].map((name) => [name, { version: '1.0.0' }])),
    ...(sandboxRoots.length > 0 ? { sandboxRoots: [...sandboxRoots] } : {}),
    defaultCwd: workspaceRoot,
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
      logger.info({ socketId: socket.id, workspaceId, workspaceName, ...(options.installId ? { installId: options.installId } : {}), executorVersion: announcement.executorVersion }, 'socket connected; announcing workspace')
      socket.emit('executor:announce', announcement)
      resolve()
    })
  })

  socket.on('connect_error', (err) => {
    const summary = connectionErrorSummary(err)
    logger.warn(summary, 'host connection failed; retrying')
    logger.debug({ ...summary, diagnostic: compactDiagnostic(err) }, 'host connection failure diagnostic')
  })
  socket.on('disconnect', (reason) => {
    logger.info({ reason }, 'socket disconnected')
    // Interactive terminals cannot be safely resumed after losing their output
    // transport. Close them eagerly so shells do not continue consuming CPU or
    // mutating the workspace invisibly while the dashboard is disconnected.
    terminals.closeAll()
  })
  socket.io.on('reconnect_attempt', (n) => {
    logger.info({ attempt: n }, 'socket reconnect attempt')
  })
  socket.io.on('reconnect_failed', () => {
    logger.warn('socket reconnect attempt budget exhausted unexpectedly; executor will remain alive')
  })

  logger.info({ host: options.host, namespace: '/executor' }, 'dialing host executor namespace')

  // Permanent-error latch. Any handler that discovers we cannot recover
  // resolves this once — the CLI awaits it to exit with a specific code.
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
    logger.info('welcome from host; token saved, ready for tool calls')
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
    // recoverable — let socket.io keep retrying.
  })

  socket.on('tool:call', async (payload: ToolCallMessage, ack) => {
    const internal = payload.name.startsWith('__')
    // Internal control-plane reads must never depend on a writable workspace
    // receipt directory. Agent tools keep the durable exactly-once barrier.
    if (!internal) await receiptStoreReady
    const key = receiptKey(payload.sessionId, payload.callId)
    const cached = completedCalls.get(key) ?? (!internal ? receiptStore?.get(key) : undefined)
    if (cached) {
      logger.debug({ sessionId: payload.sessionId, callId: payload.callId, tool: payload.name }, 'tool result served from execution cache')
      ack(cached)
      return
    }
    if (drainRequested) {
      logger.warn({ sessionId: payload.sessionId, callId: payload.callId, tool: payload.name }, 'tool rejected while Executor is draining')
      ack({ callId: payload.callId, ok: false, content: 'ERROR: EBUSY: executor is draining for a managed update; retry after reconnect' })
      return
    }
    if (inFlight.has(key)) {
      const waiters = inFlightAcks.get(key) ?? []
      waiters.push(ack)
      inFlightAcks.set(key, waiters)
      return
    }

    const controller = new AbortController()
    inFlight.set(key, controller)
    inFlightAcks.set(key, [ack])
    const started = performance.now()
    logger.info({ sessionId: payload.sessionId, callId: payload.callId, tool: payload.name, internal, input: safeToolInput(payload.input), ...(payload.cwd ? { cwd: payload.cwd } : {}) }, 'tool execution started')
    const rawResult = await runOne(tools, sandbox, controller.signal, payload, overflowConfig, options.networkPolicy, async (event) => {
      await new Promise<void>((resolve, reject) => socket.timeout(5_000).emit('executor:network_audit', event, (error, result) => error || !result?.accepted ? reject(error ?? new Error('network audit rejected')) : resolve()))
    })
    const result = { ...rawResult, durationMs: Math.max(0, Math.round(performance.now() - started)) }
    let replyResult = result
    try {
      if (!internal) await receiptStore?.set(key, result)
      rememberCompleted(key, result)
    } catch (error) {
      logger.warn({ err: error, sessionId: payload.sessionId, callId: payload.callId, tool: payload.name, durationMs: result.durationMs }, 'tool result durability failed; returning an explicit failure instead of timing out')
      replyResult = {
        callId: payload.callId,
        ok: false,
        content: `ERROR: EDURABILITY: tool completed but its execution receipt could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: result.durationMs,
      }
      rememberCompleted(key, replyResult)
    } finally {
      inFlight.delete(key)
      const waiters = inFlightAcks.get(key) ?? []
      inFlightAcks.delete(key)
      logger.info({ sessionId: payload.sessionId, callId: payload.callId, tool: payload.name, internal, ok: replyResult.ok, durationMs: result.durationMs, resultBytes: Buffer.byteLength(replyResult.content, 'utf8') }, 'tool execution completed')
      for (const reply of waiters) reply(replyResult)
    }
  })

  socket.on('tool:cancel', (payload: ToolCancelMessage) => {
    const ctrl = inFlight.get(receiptKey(payload.sessionId, payload.callId))
    logger.info({ sessionId: payload.sessionId, callId: payload.callId, found: Boolean(ctrl) }, 'tool cancellation requested')
    if (ctrl) ctrl.abort()
  })

  socket.on('executor:health_ping', (_sentAt, ack) => ack(Date.now()))

  const terminals = createTerminalManager({
    sandbox,
    emitOutput(payload) {
      socket.emit('executor:terminal_output', payload)
    },
    emitExit(payload) {
      socket.emit('executor:terminal_exit', payload)
    },
  })

  socket.on('terminal:create', async (payload, ack) => {
    if (payload.workspaceId !== workspaceId) {
      ack({ requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, error: 'workspace mismatch' })
      return
    }
    ack(await terminals.create(payload))
  })

  socket.on('terminal:input', (payload) => {
    if (payload.workspaceId === workspaceId) terminals.input(payload)
  })

  socket.on('terminal:resize', (payload) => {
    if (payload.workspaceId === workspaceId) terminals.resize(payload)
  })

  socket.on('terminal:kill', (payload, ack) => {
    if (payload.workspaceId !== workspaceId) {
      ack({ requestId: payload.requestId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, terminalId: payload.terminalId, killed: false, error: 'workspace mismatch' })
      return
    }
    ack(terminals.kill(payload))
  })

  socket.on('terminal:close_session', (payload) => {
    if (payload.workspaceId === workspaceId) terminals.closeSession(payload)
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
    activeToolCount: () => inFlight.size,
    activeTerminalCount: () => terminals.activeCount(),
    draining: () => drainRequested,
    beginDrain() { drainRequested = true },
    resume() { drainRequested = false },
    close() {
      unsubscribeBg()
      terminals.closeAll()
      for (const c of inFlight.values()) c.abort()
      inFlight.clear()
      socket.disconnect()
    },
  }
}

function executorCapabilities(tools: ReadonlyMap<string, Tool>, sandboxRoots: readonly string[]): ExecutorAnnounce['capabilities'] {
  return {
    schemaVersion: 1,
    features: {
      backgroundShell: tools.has('bash_output') && tools.has('kill_shell'),
      filePicker: tools.has('__fs_list_dirs') && tools.has('__fs_list_files') && tools.has('__workspace_read_binary'),
      overflowFiles: tools.has('__fs_read_overflow'),
      workspaceSandbox: sandboxRoots.length > 0,
    },
  }
}

function executorBuildInfo(): BuildMetadata {
  const globalValue = (globalThis as typeof globalThis & {
    __AGENT_KERNEL_BUILD_INFO__?: unknown
  }).__AGENT_KERNEL_BUILD_INFO__
  return parseBuildInfo(globalValue) ?? {
    releaseTag: process.env.AGENT_KERNEL_RELEASE_TAG ?? 'local',
    gitCommit: process.env.AGENT_KERNEL_GIT_COMMIT ?? 'unknown',
    builtAt: process.env.AGENT_KERNEL_BUILT_AT ?? 'unknown',
    artifactKind: 'source',
    dashboardMode: 'none',
  }
}

function parseBuildInfo(value: unknown): BuildMetadata | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const artifactKind = record.artifactKind
  const dashboardMode = record.dashboardMode
  if (artifactKind !== 'source' && artifactKind !== 'cjs' && artifactKind !== 'native') return null
  if (dashboardMode !== 'vite' && dashboardMode !== 'static' && dashboardMode !== 'embedded' && dashboardMode !== 'none') return null
  return {
    releaseTag: typeof record.releaseTag === 'string' ? record.releaseTag : 'unknown',
    gitCommit: typeof record.gitCommit === 'string' ? record.gitCommit : 'unknown',
    builtAt: typeof record.builtAt === 'string' ? record.builtAt : 'unknown',
    artifactKind,
    dashboardMode,
    ...(typeof record.embeddedDashboardFiles === 'number' ? { embeddedDashboardFiles: record.embeddedDashboardFiles } : {}),
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
  networkPolicy?: import('@agent-kernel/shared').NetworkPolicy,
  emitNetworkAudit?: (event: import('@agent-kernel/shared').NetworkAuditEvent) => Promise<void>,
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
      callId: payload.callId,
      sandbox,
      signal,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
      ...(networkPolicy ? { networkPolicy } : {}),
      ...(emitNetworkAudit ? { emitNetworkAudit } : {}),
    })
    if (OVERFLOW_EXEMPT_TOOLS.has(payload.name) || payload.name.startsWith('__')) {
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
        failure: failureForToolError(err.code),
      }
    }
    return {
      callId: payload.callId,
      ok: false,
      content: `ERROR: EIO: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
