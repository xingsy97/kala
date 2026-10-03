import { describe, expect, it, vi } from 'vitest'

import type { AzureSpeechCredentialStore } from './credential-store.js'
import { transcribeAzureSpeechAudio } from './fast-transcription.js'

describe('transcribeAzureSpeechAudio', () => {
  it('sends transient audio to the regional fast transcription endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://japaneast.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15')
      expect(new Headers(init?.headers).get('Ocp-Apim-Subscription-Key')).toBe('test-speech-key-value')
      expect(init?.body).toBeInstanceOf(FormData)
      const body = init?.body as FormData
      expect(body.get('audio')).toBeInstanceOf(Blob)
      expect(await (body.get('definition') as Blob).text()).toBe(JSON.stringify({ locales: ['zh-CN', 'en-US'] }))
      return Response.json({ combinedPhrases: [{ text: 'Hello，世界。' }] })
    })
    await expect(transcribeAzureSpeechAudio(store(), {
      audio: Buffer.from('audio'),
      mediaType: 'audio/webm',
    }, { fetchImpl })).resolves.toEqual({ text: 'Hello，世界。' })
  })

  it('does not expose an Azure response body when transcription fails', async () => {
    await expect(transcribeAzureSpeechAudio(store(), {
      audio: Buffer.from('audio'),
      mediaType: 'audio/webm',
    }, {
      fetchImpl: async () => new Response('sensitive upstream detail', { status: 403 }),
    })).rejects.toThrow('Azure Speech transcription failed (HTTP 403)')
  })
})

function store(): AzureSpeechCredentialStore {
  return {
    get: () => ({
      apiKey: 'test-speech-key-value',
      endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
      region: 'japaneast',
      enabled: true,
      mode: 'after_recording',
      realtimeMaxMinutes: 15,
      afterRecordingMaxMinutes: 15,
    }),
    status: () => ({
      configured: true,
      provider: 'azure',
      endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
      region: 'japaneast',
      enabled: true,
      mode: 'after_recording',
      realtimeMaxMinutes: 15,
      afterRecordingMaxMinutes: 15,
    }),
    set: () => { throw new Error('not used') },
    delete: () => { throw new Error('not used') },
  }
}
