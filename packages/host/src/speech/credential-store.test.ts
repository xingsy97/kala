import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_AZURE_SPEECH_ENDPOINT,
  LocalAzureSpeechCredentialStore,
  normalizeAzureSpeechEndpoint,
} from './credential-store.js'

const roots: string[] = []
const TEST_KEY = 'azure-speech-test-key-value'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LocalAzureSpeechCredentialStore', () => {
  it('encrypts the key, preserves endpoint settings, and never exposes the key in status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'azure-speech-credentials-'))
    roots.push(root)
    const store = new LocalAzureSpeechCredentialStore(root)

    expect(await store.status()).toEqual({
      configured: false,
      provider: 'azure',
      endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT,
      region: 'japaneast',
      enabled: false,
      mode: 'realtime',
    })
    const status = await store.set({ endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT, apiKey: TEST_KEY, enabled: true, mode: 'after_recording' })
    expect(status).toMatchObject({ configured: true, provider: 'azure', region: 'japaneast', enabled: true, mode: 'after_recording' })
    expect(JSON.stringify(status)).not.toContain(TEST_KEY)
    expect(await store.get()).toEqual({
      apiKey: TEST_KEY,
      endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT,
      region: 'japaneast',
      enabled: true,
      mode: 'after_recording',
    })
    expect(await readFile(join(root, 'azure-speech.json'), 'utf8')).not.toContain(TEST_KEY)
    expect((await stat(join(root, 'speech-master.key'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'azure-speech.json'))).mode & 0o777).toBe(0o600)

    await store.set({ endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT, enabled: false, mode: 'realtime' })
    expect((await store.get())?.apiKey).toBe(TEST_KEY)
    expect((await store.status()).enabled).toBe(false)
    expect(await store.delete()).toMatchObject({ configured: false, enabled: false })
  })

  it('accepts only regional Azure Cognitive Services HTTPS endpoints', () => {
    expect(normalizeAzureSpeechEndpoint('https://JapanEast.api.cognitive.microsoft.com')).toEqual({
      endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT,
      region: 'japaneast',
    })
    for (const endpoint of [
      'http://japaneast.api.cognitive.microsoft.com/',
      'https://localhost/',
      'https://japaneast.api.cognitive.microsoft.com/path',
      'https://example.com/',
    ]) {
      expect(() => normalizeAzureSpeechEndpoint(endpoint)).toThrow()
    }
  })
})
