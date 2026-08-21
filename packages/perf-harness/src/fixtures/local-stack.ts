import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { rm } from 'node:fs/promises'

import { io as connectSocket } from 'socket.io-client'
import { PROTOCOL_VERSION, type ProductDeploymentConfig, type RuntimeCapabilities } from '@agent-kernel/shared'
import { startHostServer, type HostServer, type LLMAdapter } from '@agent-kernel/host'
import { startExecutor } from '@agent-kernel/executor'

import { dashboardDistDir, isDashboardBuilt } from './repo-paths.js'

/**
 * A local, in-process stack for browser scenarios:
 *   - a real host (with a scripted, no-API-key LLM) on an ephemeral port,
 *   - a real executor attached to a throwaway workspace,
 *   - a tiny static server serving the built dashboard bundle (SPA fallback),
 *   - a session created and ready.
 *
 * The dashboard is served from its own origin and points at the host via the
 * `?host=` query param (the host's socket.io CORS defaults to `*`). Keeping the
 * dashboard and host on separate origins mirrors how scenarios drive them and
 * avoids coupling to the host's own static handler. Everything is deterministic
 * and torn down by a single {@link LocalStack.close}.
 */

export type LocalStackOptions = {
  /** Scripted LLM that shapes the load (see fixtures/scripted-llm). */
  llm: LLMAdapter
  /** Tool schemas the session may call. Defaults to a single `write` tool. */
  tools?: AgentToolSchema[]
  /** System prompt for the session. */
  systemPrompt?: string
  /** Stable ids so scenarios can address the session/workspace. */
  sessionId?: string
  workspaceId?: string
  workspaceName?: string
  /** Tool execution timeout (ms). */
  toolTimeoutMs?: number
  deployment?: ProductDeploymentConfig
  capabilities?: RuntimeCapabilities
}

/** Minimal shape of a tool schema (kept local so the harness needn't import kernel types). */
export type AgentToolSchema = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  requiresApproval?: boolean
}

export type LocalStack = {
  /** Origin the dashboard bundle is served from. */
  readonly dashboardOrigin: string
  /** Host origin the dashboard connects to. */
  readonly hostOrigin: string
  /** Full URL a scenario should open: dashboard origin + `?host=…`. */
  readonly dashboardUrl: string
  readonly port: number
  readonly sessionId: string
  readonly workspaceId: string
  readonly server: HostServer
  /** Tear down executor, host, static server, sockets and temp dirs. Idempotent. */
  close(): Promise<void>
}

const DEFAULT_WRITE_TOOL: AgentToolSchema = {
  name: 'write',
  description: 'write a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  requiresApproval: false,
}

/**
 * Boot the full local stack and wait until the session is ready with an
 * executor attached. Throws if the dashboard bundle has not been built yet.
 */
export async function startLocalStack(options: LocalStackOptions): Promise<LocalStack> {
  if (!isDashboardBuilt()) {
    throw new Error(
      'Dashboard bundle not found. Build it first: `pnpm --filter @agent-kernel/dashboard build`.',
    )
  }

  const sessionId = options.sessionId ?? 'perf-session'
  const workspaceId = options.workspaceId ?? 'perf-workspace'
  const workspaceName = options.workspaceName ?? 'perf-box'
  const tools = options.tools ?? [DEFAULT_WRITE_TOOL]
  const sessionsDir = mkdtempSync(join(tmpdir(), 'ak-perf-sessions-'))
  const workspaceDir = mkdtempSync(join(tmpdir(), 'ak-perf-workspace-'))

  const server = await startHostServer({
    port: 0,
    sessionsDir,
    llm: options.llm,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentConfig is host-internal; the harness passes a minimal, valid config.
    defaultConfig: { tools: tools as any, systemPrompt: options.systemPrompt ?? 'perf-harness system prompt' } as any,
    toolTimeoutMs: options.toolTimeoutMs ?? 5000,
    ...(options.deployment ? { deployment: options.deployment } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    settings: {
      providers: [], defaultModel: '', hooks: [],
      paths: { claudeSettings: '', codexConfig: '', manualModels: '', hooksConfig: '', sessionsDir },
      mcp: { supported: false, note: 'perf harness' },
    },
  })
  const hostOrigin = `http://localhost:${server.port}`

  const staticServer = await startStaticServer(dashboardDistDir())
  const dashboardOrigin = `http://localhost:${staticServer.port}`
  const dashboardUrl = `${dashboardOrigin}/?host=${encodeURIComponent(hostOrigin)}&sessionId=${encodeURIComponent(sessionId)}`

  // A dashboard socket connects first so the host materialises the session on
  // disk before the executor attaches; then we create the session bound to the
  // workspace so it shows up in the sidebar and is pre-selected.
  const dashboard = connectSocket(`${hostOrigin}/dashboard`, {
    transports: ['websocket'],
    auth: { sessionId, role: 'dashboard', clientVersion: PROTOCOL_VERSION },
    reconnection: false,
  })
  dashboard.emit('client:create_session', { sessionId, workspaceId, workspaceName })
  await waitForEvent(dashboard, 'session:ready', 8000)

  const executor = startExecutor({
    host: hostOrigin,
    workspaceId,
    workspaceName,
    sandboxRoots: [workspaceDir],
  })
  await executor.ready
  dashboard.close()

  let closed = false
  return {
    dashboardOrigin,
    hostOrigin,
    dashboardUrl,
    port: server.port,
    sessionId,
    workspaceId,
    server,
    async close() {
      if (closed) return
      closed = true
      try { executor.close() } catch { /* ignore */ }
      try { await server.close() } catch { /* ignore */ }
      try { await staticServer.close() } catch { /* ignore */ }
      await Promise.allSettled([
        rm(sessionsDir, { recursive: true, force: true }),
        rm(workspaceDir, { recursive: true, force: true }),
      ])
    },
  }
}

function waitForEvent(socket: ReturnType<typeof connectSocket>, event: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs)
    socket.once(event, () => { clearTimeout(timer); resolve() })
    socket.once('connect_error', (err: Error) => { clearTimeout(timer); reject(err) })
  })
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/** A minimal static file server with SPA fallback to index.html. */
async function startStaticServer(root: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
    let filePath = join(root, rel === '/' ? 'index.html' : rel)
    if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA fallback: unknown non-asset paths serve index.html.
      filePath = join(root, 'index.html')
    }
    res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream')
    // No caching so scenarios always exercise the freshly built bundle.
    res.setHeader('Cache-Control', 'no-store')
    createReadStream(filePath).pipe(res)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
