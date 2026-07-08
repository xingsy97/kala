/**
 * HTTP request routing for the host process.
 *
 *   - `/models`     JSON, GET/HEAD     -  sanitised model list for the dashboard
 *   - `/settings`   JSON, GET/HEAD     -  settings snapshot
 *   - `/settings/models` POST/DELETE   -  manually managed model ids
 *   - everything else                  -  static bundle (dashboard `dist/`),
 *                                       with SPA fallback to `index.html`
 *
 * Socket.IO owns `/socket.io/*` on the same HTTP server; every handler here
 * short-circuits on that prefix so the two listeners don't clobber each
 * other. JSON routes always run first because static serving falls back to
 * `index.html` for unknown paths and would otherwise mask a missing endpoint.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import { extname, join, normalize, resolve as resolvePath, sep } from 'node:path'

import type {
  ClientAddManualModel,
  ClientDeleteManualModel,
  ModelInfo,
  ServerModelsPayload,
  ServerSettingsPayload,
} from '@agent-kernel/shared'

import { buildArtifactManifest } from '../artifact-manifest.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const ROUTE_CLAIMED = Symbol('agent-kernel-route-claimed')

export function attachJsonRoutes(
  server: HttpServer,
  payloads: {
    models: readonly ModelInfo[] | (() => readonly ModelInfo[])
    defaultModel: string | (() => string)
    settings?: ServerSettingsPayload | (() => ServerSettingsPayload)
    addManualModel?: (input: ClientAddManualModel) => ServerSettingsPayload
    deleteManualModel?: (input: ClientDeleteManualModel) => ServerSettingsPayload
    artifactRootDir?: string | false
  },
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    // Strip query string / fragment before matching, so `/models?ts= - `
    // (cache-buster) still hits.
    const path = url.split('?')[0]!.split('#')[0]
    if (path === '/settings/models' && req.method === 'POST' && payloads.addManualModel) {
      claimRoute(req)
      void readJson(req)
        .then((body) => sendJson(req, res, payloads.addManualModel!(body as ClientAddManualModel)))
        .catch((err: unknown) => sendError(res, 400, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/settings/models' && req.method === 'DELETE' && payloads.deleteManualModel) {
      claimRoute(req)
      const parsed = new URL(url, 'http://x')
      try {
        sendJson(
          req,
          res,
          payloads.deleteManualModel({
            providerId: parsed.searchParams.get('providerId') ?? '',
            id: parsed.searchParams.get('id') ?? '',
          }),
        )
      } catch (err: unknown) {
        sendError(res, 400, err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    if (path === '/artifacts/manifest') {
      claimRoute(req)
      if (!payloads.artifactRootDir) {
        sendError(res, 404, 'artifact capture is not configured')
        return
      }
      void buildArtifactManifest({ rootDir: payloads.artifactRootDir })
        .then((result) => sendJson(req, res, result.manifest))
        .catch((err: unknown) => sendError(res, 500, err instanceof Error ? err.message : String(err)))
      return
    }
    if (path === '/models') {
      claimRoute(req)
      const body: ServerModelsPayload = {
        models: valueOf(payloads.models),
        defaultModel: valueOf(payloads.defaultModel),
      }
      sendJson(req, res, body)
      return
    }
    if (path === '/settings' && payloads.settings) {
      claimRoute(req)
      sendJson(req, res, valueOf(payloads.settings))
      return
    }
  })
}

function valueOf<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

function claimRoute(req: IncomingMessage): void {
  ;(req as IncomingMessage & { [ROUTE_CLAIMED]?: true })[ROUTE_CLAIMED] = true
}

function routeClaimed(req: IncomingMessage): boolean {
  return (req as IncomingMessage & { [ROUTE_CLAIMED]?: true })[ROUTE_CLAIMED] === true
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return {}
  return JSON.parse(raw) as unknown
}

function sendJson(req: IncomingMessage, res: ServerResponse, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json).toString(),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(json)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const json = JSON.stringify({ error: message })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json).toString(),
  })
  res.end(json)
}

export function attachStaticHandler(server: HttpServer, staticDir: string): void {
  const root = resolvePath(staticDir)
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // Socket.IO's own request listener handles /socket.io/*; skip so we don't
    // clobber its response.
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return
    // Another handler (e.g. `/models` JSON) may have already responded.
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return

    void serveStatic(root, req, res)
  })
}

export function attachRequestHandler(
  server: HttpServer,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url.startsWith('/socket.io/')) return
    if (routeClaimed(req) || res.headersSent || res.writableEnded) return
    handler(req, res)
  })
}

async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x')
  const requested = decodeURIComponent(url.pathname)
  const rel = normalize(requested).replace(/^[/\\]+/, '')
  const abs = join(root, rel)
  // Reject traversal above root.
  if (!abs.startsWith(root + sep) && abs !== root) {
    res.writeHead(403).end()
    return
  }

  const filePath = await pickFile(abs, root)
  if (!filePath) {
    res.writeHead(404).end('not found')
    return
  }
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = { 'content-type': mime }
  // Vite emits `assets/*.<hash>.<ext>`  -  safe to cache forever. Everything
  // else (index.html, favicon, etc.) must revalidate so stale dashboard
  // builds don't survive a redeploy in the user's browser.
  if (/[/\\]assets[/\\][^/\\]+\.[0-9a-f]{6,}\./i.test(filePath)) {
    headers['cache-control'] = 'public, max-age=31536000, immutable'
  } else {
    headers['cache-control'] = 'no-cache, must-revalidate'
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

async function pickFile(abs: string, root: string): Promise<string | null> {
  try {
    const st = await stat(abs)
    if (st.isFile()) return abs
    if (st.isDirectory()) {
      const idx = join(abs, 'index.html')
      try {
        const s = await stat(idx)
        if (s.isFile()) return idx
      } catch {}
    }
  } catch {}
  // SPA fallback: unknown routes serve index.html (client-side routing).
  const fallback = join(root, 'index.html')
  try {
    const s = await stat(fallback)
    if (s.isFile()) return fallback
  } catch {}
  return null
}
