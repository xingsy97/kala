import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadSpeechSettings, transcribeSpeechRecording } from './speech-api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('speech API', () => {
  it('defaults older settings responses to realtime mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      configured: true,
      provider: 'azure',
      endpoint: 'https://japaneast.api.cognitive.microsoft.com/',
      region: 'japaneast',
      enabled: true,
    })))

    await expect(loadSpeechSettings()).resolves.toMatchObject({ mode: 'realtime' })
  })

  it('uploads an in-memory recording without wrapping it in JSON', async () => {
    const recording = new Blob(['audio'], { type: 'audio/webm' })
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('content-type')).toBe('audio/webm')
      expect(init?.body).toBe(recording)
      return Response.json({ text: 'Hello，世界。' })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(transcribeSpeechRecording(recording)).resolves.toBe('Hello，世界。')
    expect(fetchMock).toHaveBeenCalledWith('/runtime/speech/transcribe', expect.any(Object))
  })
})
