import { describe, expect, it, vi } from 'vitest'

import type { AzureSpeechCredentialStore } from './credential-store.js'
import { issueAzureSpeechToken } from './token-service.js'

const TEST_KEY = 'azure-speech-test-key'

describe('issueAzureSpeechToken', () => {
  it('exchanges the stored key without returning or logging it', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://japaneast.api.cognitive.microsoft.com/sts/v1.0/issueToken')
      expect(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key')).toBe(TEST_KEY)
      return new Response('short-lived-token', { status: 200 })
    })
    const result = await issueAzureSpeechToken(store(true), { fetchImpl })
    expect(result).toEqual({
      token: 'short-lived-token',
      endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
      region: 'japaneast',
      expiresInSeconds: 600,
    })
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
  })

  it('rejects disabled configuration unless explicitly testing it', async () => {
    const fetchImpl = vi.fn(async () => new Response('token', { status: 200 }))
    await expect(issueAzureSpeechToken(store(false), { fetchImpl })).rejects.toThrow('disabled')
    await expect(issueAzureSpeechToken(store(false), { fetchImpl, allowDisabled: true })).resolves.toMatchObject({ token: 'token' })
  })

  it('does not issue browser tokens while after-recording mode is selected', async () => {
    const fetchImpl = vi.fn(async () => new Response('token', { status: 200 }))
    await expect(issueAzureSpeechToken(store(true, 'after_recording'), { fetchImpl })).rejects.toThrow('live transcription is not enabled')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

function store(enabled: boolean, mode: 'realtime' | 'after_recording' = 'realtime'): AzureSpeechCredentialStore {
  return {
    get: () => ({
      apiKey: TEST_KEY,
      endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
      region: 'japaneast',
      enabled,
      mode,
      realtimeMaxMinutes: 15,
      afterRecordingMaxMinutes: 15,
    }),
    status: () => ({
      configured: true,
      provider: 'azure',
      endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
      region: 'japaneast',
      enabled,
      mode,
      realtimeMaxMinutes: 15,
      afterRecordingMaxMinutes: 15,
    }),
    set: () => { throw new Error('not used') },
    delete: () => { throw new Error('not used') },
  }
}
