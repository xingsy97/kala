import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PRIVATE_CLOUD_DEPLOYMENT } from '@agent-kernel/shared'

import type { AzureSpeechCredential, AzureSpeechCredentialStatus, AzureSpeechCredentialStore } from '../speech/credential-store.js'
import { attachJsonRoutes } from './routes.js'

const TEST_KEY = 'azure-route-test-credential'
const TEST_ENDPOINT = 'https://japaneast.api.cognitive.microsoft.com/'
const originalFetch = globalThis.fetch
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('Azure Speech settings routes', () => {
  it('supports configuration CRUD without returning the long-lived key', async () => {
    const credentials = memoryStore()
    const baseUrl = await startRoutes(credentials)

    const initial = await originalFetch(`${baseUrl}/settings/speech`)
    expect(initial.headers.get('cache-control')).toBe('no-store')
    expect(await initial.json()).toMatchObject({
      configured: false,
      endpoint: TEST_ENDPOINT,
      enabled: false,
      realtimeMaxMinutes: 15,
      afterRecordingMaxMinutes: 15,
    })

    const saved = await originalFetch(`${baseUrl}/settings/speech`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: TEST_ENDPOINT,
        apiKey: TEST_KEY,
        enabled: true,
        mode: 'after_recording',
        realtimeMaxMinutes: 3,
        afterRecordingMaxMinutes: 45,
      }),
    })
    const savedText = await saved.text()
    expect(saved.status).toBe(200)
    expect(savedText).not.toContain(TEST_KEY)
    expect(JSON.parse(savedText)).toMatchObject({
      configured: true,
      region: 'japaneast',
      enabled: true,
      mode: 'after_recording',
      realtimeMaxMinutes: 3,
      afterRecordingMaxMinutes: 45,
    })

    const disabled = await originalFetch(`${baseUrl}/settings/speech`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: TEST_ENDPOINT, enabled: false, mode: 'realtime' }),
    })
    expect(await disabled.json()).toMatchObject({
      configured: true,
      enabled: false,
      realtimeMaxMinutes: 3,
      afterRecordingMaxMinutes: 45,
    })
    expect((await credentials.get())?.apiKey).toBe(TEST_KEY)

    const removed = await originalFetch(`${baseUrl}/settings/speech`, { method: 'DELETE' })
    expect(await removed.json()).toMatchObject({
      configured: false,
      enabled: false,
      realtimeMaxMinutes: 15,
      afterRecordingMaxMinutes: 15,
    })
  })

  it.each([
    ['realtimeMaxMinutes', 0],
    ['realtimeMaxMinutes', 121],
    ['realtimeMaxMinutes', 1.5],
    ['afterRecordingMaxMinutes', '15'],
  ])('rejects invalid %s values', async (field, value) => {
    const credentials = memoryStore()
    const set = vi.spyOn(credentials, 'set')
    const baseUrl = await startRoutes(credentials)

    const response = await originalFetch(`${baseUrl}/settings/speech`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: TEST_ENDPOINT, apiKey: TEST_KEY, [field]: value }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: `${field} must be an integer between 1 and 120` })
    expect(set).not.toHaveBeenCalled()
  })

  it('issues only the short-lived token to an authenticated writable dashboard', async () => {
    const credentials = memoryStore({ apiKey: TEST_KEY, endpoint: TEST_ENDPOINT, region: 'japaneast', enabled: true, mode: 'realtime', realtimeMaxMinutes: 15, afterRecordingMaxMinutes: 15 })
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key')).toBe(TEST_KEY)
      return new Response('short-token', { status: 200 })
    }))
    const baseUrl = await startRoutes(credentials)

    const response = await originalFetch(`${baseUrl}/runtime/speech/token`, { method: 'POST' })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).not.toContain(TEST_KEY)
    expect(JSON.parse(text)).toMatchObject({ token: 'short-token', region: 'japaneast', expiresInSeconds: 600 })
  })

  it('forwards a bounded recording to fast transcription without exposing the key', async () => {
    const credentials = memoryStore({ apiKey: TEST_KEY, endpoint: TEST_ENDPOINT, region: 'japaneast', enabled: true, mode: 'after_recording', realtimeMaxMinutes: 15, afterRecordingMaxMinutes: 15 })
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key')).toBe(TEST_KEY)
      return Response.json({ combinedPhrases: [{ text: 'Mixed language result.' }] })
    }))
    const baseUrl = await startRoutes(credentials)

    const response = await originalFetch(`${baseUrl}/runtime/speech/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: new Uint8Array([1, 2, 3]),
    })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).not.toContain(TEST_KEY)
    expect(JSON.parse(text)).toEqual({ text: 'Mixed language result.' })
  })

  it('requires an ingress admin to change or test credentials in multi-tenant deployments', async () => {
    const credentials = memoryStore({ apiKey: TEST_KEY, endpoint: TEST_ENDPOINT, region: 'japaneast', enabled: true, mode: 'realtime', realtimeMaxMinutes: 15, afterRecordingMaxMinutes: 15 })
    const set = vi.spyOn(credentials, 'set')
    const baseUrl = await startRoutes(credentials, PRIVATE_CLOUD_DEPLOYMENT)
    const memberHeaders = {
      'content-type': 'application/json',
      'x-agent-runlab-principal': 'member@example.test',
      'x-agent-runlab-organization-id': 'org_speech',
      'x-agent-runlab-organization-role': 'member',
    }

    const update = await originalFetch(`${baseUrl}/settings/speech`, {
      method: 'PUT',
      headers: memberHeaders,
      body: JSON.stringify({ endpoint: TEST_ENDPOINT, apiKey: TEST_KEY, enabled: true }),
    })
    expect(update.status).toBe(403)
    expect(set).not.toHaveBeenCalled()

    const test = await originalFetch(`${baseUrl}/settings/speech/test`, { method: 'POST', headers: memberHeaders })
    expect(test.status).toBe(403)
  })
})

async function startRoutes(
  speechCredentials: AzureSpeechCredentialStore,
  deployment?: Parameters<typeof attachJsonRoutes>[1]['deployment'],
): Promise<string> {
  const server = createServer()
  servers.push(server)
  attachJsonRoutes(server, { models: [], defaultModel: '', speechCredentials, ...(deployment ? { deployment } : {}) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function memoryStore(initial?: AzureSpeechCredential): AzureSpeechCredentialStore {
  let value = initial
  let updatedAt: string | undefined
  const status = (): AzureSpeechCredentialStatus => value
    ? {
        configured: true,
        provider: 'azure',
        endpoint: value.endpoint,
        region: value.region,
        enabled: value.enabled,
        mode: value.mode,
        realtimeMaxMinutes: value.realtimeMaxMinutes,
        afterRecordingMaxMinutes: value.afterRecordingMaxMinutes,
        updatedAt,
      }
    : {
        configured: false,
        provider: 'azure',
        endpoint: TEST_ENDPOINT,
        region: 'japaneast',
        enabled: false,
        mode: 'realtime',
        realtimeMaxMinutes: 15,
        afterRecordingMaxMinutes: 15,
      }
  return {
    get: () => value,
    status,
    set: (input) => {
      if (!input.apiKey && !value) throw new Error('an Azure Speech key is required')
      value = {
        apiKey: input.apiKey ?? value!.apiKey,
        endpoint: input.endpoint,
        region: 'japaneast',
        enabled: input.enabled,
        mode: input.mode,
        realtimeMaxMinutes: input.realtimeMaxMinutes ?? value?.realtimeMaxMinutes ?? 15,
        afterRecordingMaxMinutes: input.afterRecordingMaxMinutes ?? value?.afterRecordingMaxMinutes ?? 15,
      }
      updatedAt = '2026-09-28T00:00:00.000Z'
      return status()
    },
    delete: () => {
      value = undefined
      updatedAt = undefined
      return status()
    },
  }
}
