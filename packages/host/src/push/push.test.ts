import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PushSubscriptionStore } from './store.js'
import { createPushDispatcher } from './dispatch.js'

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
    generateVAPIDKeys: () => ({ publicKey: 'test-pub', privateKey: 'test-priv' }),
  },
}))

// Import after mock so dispatch.ts pulls the mocked module.
import webpush from 'web-push'

const FAKE_VAPID = { publicKey: 'test-pub', privateKey: 'test-priv', subject: 'mailto:test@test' }

const SUB_APPROVAL_ONLY = {
  endpoint: 'https://push.example/only-approval',
  keys: { p256dh: 'p', auth: 'a' },
  kinds: ['approval_required' as const],
  createdAt: '2026-07-23T00:00:00Z',
  updatedAt: '2026-07-23T00:00:00Z',
}
const SUB_ERROR_ONLY = {
  endpoint: 'https://push.example/only-error',
  keys: { p256dh: 'p', auth: 'a' },
  kinds: ['session_error' as const],
  createdAt: '2026-07-23T00:00:00Z',
  updatedAt: '2026-07-23T00:00:00Z',
}
const SUB_ALL = {
  endpoint: 'https://push.example/all',
  keys: { p256dh: 'p', auth: 'a' },
  kinds: ['approval_required', 'session_error', 'waiting_for_user'] as const,
  createdAt: '2026-07-23T00:00:00Z',
  updatedAt: '2026-07-23T00:00:00Z',
}

describe('PushSubscriptionStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-push-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips subscriptions through JSONL', async () => {
    const path = join(dir, 'subs.jsonl')
    const a = new PushSubscriptionStore(path)
    a.upsert(SUB_APPROVAL_ONLY)
    a.upsert(SUB_ERROR_ONLY)
    expect(a.size()).toBe(2)

    const b = new PushSubscriptionStore(path)
    await b.load()
    expect(b.size()).toBe(2)
    expect(b.list().map((r) => r.endpoint).sort()).toEqual([
      SUB_APPROVAL_ONLY.endpoint,
      SUB_ERROR_ONLY.endpoint,
    ].sort())
  })

  it('upsert on same endpoint replaces instead of duplicating', () => {
    const store = new PushSubscriptionStore(join(dir, 'subs.jsonl'))
    store.upsert(SUB_APPROVAL_ONLY)
    store.upsert({ ...SUB_APPROVAL_ONLY, kinds: ['session_error'] })
    expect(store.size()).toBe(1)
    expect(store.list()[0]!.kinds).toEqual(['session_error'])
  })

  it('remove is idempotent', () => {
    const store = new PushSubscriptionStore(join(dir, 'subs.jsonl'))
    store.upsert(SUB_APPROVAL_ONLY)
    expect(store.remove(SUB_APPROVAL_ONLY.endpoint)).toBe(true)
    expect(store.remove(SUB_APPROVAL_ONLY.endpoint)).toBe(false)
    expect(store.size()).toBe(0)
  })
})

describe('createPushDispatcher', () => {
  let dir: string
  let store: PushSubscriptionStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-push-'))
    store = new PushSubscriptionStore(join(dir, 'subs.jsonl'))
    vi.mocked(webpush.sendNotification).mockReset()
    vi.mocked(webpush.setVapidDetails).mockReset()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('short-circuits when no VAPID keys are configured', async () => {
    const dispatcher = createPushDispatcher({ store, vapid: null })
    store.upsert(SUB_ALL)
    const delivered = await dispatcher.send({
      kind: 'approval_required',
      title: 't', body: 'b', url: '/',
    })
    expect(delivered).toBe(0)
    expect(webpush.sendNotification).not.toHaveBeenCalled()
    expect(dispatcher.status()).toEqual({ configured: false })
  })

  it('only sends to subscribers whose kinds match', async () => {
    const dispatcher = createPushDispatcher({ store, vapid: FAKE_VAPID })
    store.upsert(SUB_APPROVAL_ONLY)
    store.upsert(SUB_ERROR_ONLY)
    store.upsert(SUB_ALL)
    vi.mocked(webpush.sendNotification).mockResolvedValue({ statusCode: 201, body: '', headers: {} })

    const delivered = await dispatcher.send({
      kind: 'approval_required',
      title: 't', body: 'b', url: '/',
    })
    expect(delivered).toBe(2)
    const endpoints = vi.mocked(webpush.sendNotification).mock.calls.map((call) => (call[0] as { endpoint: string }).endpoint)
    expect(endpoints.sort()).toEqual([SUB_APPROVAL_ONLY.endpoint, SUB_ALL.endpoint].sort())
  })

  it('drops subscriptions that respond 410 (gone)', async () => {
    const dispatcher = createPushDispatcher({ store, vapid: FAKE_VAPID, logger: () => {} })
    store.upsert(SUB_ALL)
    const err = Object.assign(new Error('gone'), { statusCode: 410 })
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(err)

    const delivered = await dispatcher.send({
      kind: 'waiting_for_user',
      title: 't', body: 'b', url: '/',
    })
    expect(delivered).toBe(0)
    expect(store.size()).toBe(0)
  })

  it('keeps subscriptions after transient (non-410) failures', async () => {
    const dispatcher = createPushDispatcher({ store, vapid: FAKE_VAPID, logger: () => {} })
    store.upsert(SUB_ALL)
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(Object.assign(new Error('500'), { statusCode: 500 }))
    const delivered = await dispatcher.send({
      kind: 'session_error',
      title: 't', body: 'b', url: '/',
    })
    expect(delivered).toBe(0)
    expect(store.size()).toBe(1)
  })
})
