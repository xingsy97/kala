/**
 * HTTP endpoints for Web Push subscription management.
 *
 * Three URLs, all under /push, all JSON:
 *
 *   GET   /push/vapid-public-key   → { publicKey } for pushManager.subscribe()
 *   POST  /push/subscribe          → upsert PushSubscriptionRecord
 *   POST  /push/unsubscribe        → { endpoint } removes the subscription
 *
 * Deliberately minimal: no per-kind PATCH — the client sends a fresh
 * subscribe with the current preferences whenever prefs change. This keeps
 * the server-side state trivially eventually-consistent with the browser.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  PushSubscribeRequest,
  PushVapidKeyResponse,
} from '@agent-kernel/shared/push'
import { DESKTOP_NOTIFICATION_KINDS } from '@agent-kernel/shared/push'

import type { PushDispatcher } from './dispatch.js'
import type { PushSubscriptionStore } from './store.js'
import type { VapidKeys } from './vapid.js'

type PushHttpContext = {
  store: PushSubscriptionStore
  vapid: VapidKeys | null
  dispatcher: PushDispatcher
}

export type PushRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

export function createPushRoutes(ctx: PushHttpContext): PushRouteHandler {
  return async (req, res) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]?.split('#')[0] ?? ''
    if (!path.startsWith('/push/')) return false

    if (path === '/push/vapid-public-key' && (req.method === 'GET' || req.method === 'HEAD')) {
      const body: PushVapidKeyResponse = { publicKey: ctx.vapid?.publicKey ?? null }
      sendJson(res, 200, body)
      return true
    }
    if (path === '/push/subscribe' && req.method === 'POST') {
      const parsed = await parseSubscribeBody(req)
      if (!parsed) {
        sendJson(res, 400, { error: 'invalid subscription payload' })
        return true
      }
      const now = new Date().toISOString()
      const existing = ctx.store.list().find((r) => r.endpoint === parsed.endpoint)
      ctx.store.upsert({
        endpoint: parsed.endpoint,
        keys: parsed.keys,
        kinds: parsed.kinds,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(parsed.ownerId ? { ownerId: parsed.ownerId } : {}),
        ...(parsed.userAgent ? { userAgent: parsed.userAgent } : {}),
      })
      sendJson(res, 200, { ok: true, subscribers: ctx.store.size() })
      return true
    }
    if (path === '/push/unsubscribe' && req.method === 'POST') {
      const body = await readJson<{ endpoint?: unknown }>(req)
      const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : null
      if (!endpoint) {
        sendJson(res, 400, { error: 'missing endpoint' })
        return true
      }
      const removed = ctx.store.remove(endpoint)
      sendJson(res, 200, { ok: true, removed })
      return true
    }
    return false
  }
}

async function parseSubscribeBody(req: IncomingMessage): Promise<PushSubscribeRequest | null> {
  const body = await readJson<Partial<PushSubscribeRequest>>(req)
  if (!body || typeof body.endpoint !== 'string') return null
  const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null
  const kinds = Array.isArray(body.kinds)
    ? body.kinds.filter((kind): kind is PushSubscribeRequest['kinds'][number] =>
        typeof kind === 'string' && (DESKTOP_NOTIFICATION_KINDS as readonly string[]).includes(kind),
      )
    : []
  return {
    endpoint: body.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    kinds,
    ...(typeof body.ownerId === 'string' ? { ownerId: body.ownerId } : {}),
    ...(typeof body.userAgent === 'string' ? { userAgent: body.userAgent } : {}),
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((n, c) => n + c.byteLength, 0) > 64 * 1024) {
      return null
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(encoded)),
    'cache-control': 'no-store',
  })
  res.end(encoded)
}
