/**
 * Socket.IO client that connects to the host's `/executor` namespace, announces
 * the local tool set, and services `tool:call` events by dispatching them to
 * the local tool registry.
 *
 * Every in-flight call gets its own `AbortController`; `tool:cancel` from host
 * aborts it. Tool failures become `{ ok: false, content: 'ERROR: …' }` — we
 * never let a runner exception cross the wire.
 */

import { hostname, networkInterfaces, platform } from 'node:os'
import process from 'node:process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import type {
  ExecutorAnnounce,
  ExecutorClientToServerEvents,
  ExecutorOs,
  ExecutorServerToClientEvents,
  DirListResult,
  FileContentsResult,
  FileListEntry,
  FileListResult,
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
    const input = payload.cwd
      ? { ...payload.input, cwd: payload.cwd }
      : payload.input
    const content = await tool.run(input, { sandbox, signal })
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

async function listDirs(
  requestId: string,
  workspaceId: string,
  inputPath: string | undefined,
  sandbox: Sandbox,
): Promise<DirListResult> {
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const requested = inputPath && inputPath.trim().length > 0 ? inputPath : roots[0]!
  try {
    const resolved = await sandbox.resolve(requested)
    const entries = await readdir(resolved, { withFileTypes: true })
    return {
      requestId,
      workspaceId,
      path: resolved,
      roots,
      entries: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: join(resolved, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  } catch (err) {
    return {
      requestId,
      workspaceId,
      path: requested,
      roots,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

const FILE_LIST_SKIP_DIRS = new Set<string>([
  'node_modules',
  '.git',
  '.pnpm',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
])

const FILE_LIST_DEFAULT_LIMIT = 500
const FILE_LIST_MAX_LIMIT = 2000
const FILE_LIST_WALK_CEILING = 20000

type ListFilesPayload = {
  requestId: string
  workspaceId: string
  query?: string
  limit?: number
}

async function listFiles(
  payload: ListFilesPayload,
  sandbox: Sandbox,
): Promise<FileListResult> {
  const roots = sandbox.roots.length > 0 ? sandbox.roots : [process.cwd()]
  const rawLimit = payload.limit ?? FILE_LIST_DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(FILE_LIST_MAX_LIMIT, rawLimit))
  const query = (payload.query ?? '').trim().toLowerCase()
  const matches: FileListEntry[] = []
  let walked = 0
  let truncated = false

  try {
    outer: for (const root of roots) {
      const stack: string[] = [root]
      while (stack.length > 0) {
        if (walked >= FILE_LIST_WALK_CEILING) {
          truncated = true
          break outer
        }
        const dir = stack.pop()!
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          walked += 1
          if (entry.name.startsWith('.') && entry.name !== '.') {
            if (entry.isDirectory()) continue
          }
          if (entry.isDirectory()) {
            if (FILE_LIST_SKIP_DIRS.has(entry.name)) continue
            stack.push(join(dir, entry.name))
            continue
          }
          if (!entry.isFile()) continue
          const abs = join(dir, entry.name)
          const rel = relative(root, abs).split(sep).join('/')
          if (query.length > 0 && !rel.toLowerCase().includes(query)) continue
          if (matches.length >= limit) {
            truncated = true
            break outer
          }
          matches.push({ path: rel, size: 0 })
        }
      }
    }
  } catch (err) {
    return {
      requestId: payload.requestId,
      workspaceId: payload.workspaceId,
      files: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  matches.sort((a, b) => a.path.localeCompare(b.path))
  return {
    requestId: payload.requestId,
    workspaceId: payload.workspaceId,
    files: matches,
    truncated,
  }
}

const FILE_READ_DEFAULT_MAX_BYTES = 64 * 1024
const FILE_READ_HARD_CEILING = 512 * 1024

type ReadFilePayload = {
  requestId: string
  workspaceId: string
  path: string
  maxBytes?: number
}

async function readWorkspaceFile(
  payload: ReadFilePayload,
  sandbox: Sandbox,
): Promise<FileContentsResult> {
  const requested = payload.path?.trim() ?? ''
  const base = {
    requestId: payload.requestId,
    workspaceId: payload.workspaceId,
    path: requested,
  }
  if (requested.length === 0) {
    return { ...base, error: 'EINVAL: empty path' }
  }
  const cap = Math.max(
    1,
    Math.min(FILE_READ_HARD_CEILING, payload.maxBytes ?? FILE_READ_DEFAULT_MAX_BYTES),
  )
  try {
    const resolved = await sandbox.resolve(requested)
    const info = await stat(resolved)
    if (!info.isFile()) {
      return { ...base, error: 'ENOTFILE: not a regular file' }
    }
    if (info.size > cap) {
      return { ...base, size: info.size, error: `EFBIG: file is ${info.size} bytes (limit ${cap})` }
    }
    const content = await readFile(resolved, 'utf8')
    return { ...base, content, size: info.size }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

function normalizeOs(p: NodeJS.Platform): ExecutorOs {
  if (p === 'linux' || p === 'darwin' || p === 'win32') return p
  return 'other'
}

function collectIpAddresses(): string[] {
  const out: string[] = []
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    if (!list) continue
    for (const addr of list) {
      if (addr.internal) continue
      if (addr.family === 'IPv6' && addr.address.startsWith('fe80')) continue
      out.push(addr.address)
    }
  }
  return out
}
