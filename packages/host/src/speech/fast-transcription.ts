import type { AzureSpeechCredentialStore } from './credential-store.js'

const FAST_TRANSCRIPTION_API_VERSION = '2025-10-15'
const TRANSCRIPTION_TIMEOUT_MS = 120_000

export async function transcribeAzureSpeechAudio(
  credentials: AzureSpeechCredentialStore,
  input: { audio: Buffer; mediaType: string },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ text: string }> {
  const configured = await credentials.get()
  if (!configured) throw new Error('Azure Speech is not configured')
  if (!configured.enabled) throw new Error('Azure Speech voice input is disabled')
  if (configured.mode !== 'after_recording') throw new Error('Azure Speech after-recording transcription is not enabled')
  const url = new URL('speechtotext/transcriptions:transcribe', configured.endpoint)
  url.searchParams.set('api-version', FAST_TRANSCRIPTION_API_VERSION)
  const body = new FormData()
  const audio = new Uint8Array(input.audio.byteLength)
  audio.set(input.audio)
  body.append('audio', new Blob([audio.buffer], { type: input.mediaType }), `recording.${extensionForMediaType(input.mediaType)}`)
  body.append('definition', new Blob([JSON.stringify({ locales: ['zh-CN', 'en-US'] })], { type: 'application/json' }))
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': configured.apiKey },
    body,
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Azure Speech transcription failed (HTTP ${response.status})`)
  const result = await response.json() as {
    combinedPhrases?: readonly { text?: unknown }[]
    phrases?: readonly { text?: unknown }[]
  }
  const text = [...(result.combinedPhrases ?? []), ...(result.combinedPhrases?.length ? [] : result.phrases ?? [])]
    .map((phrase) => typeof phrase.text === 'string' ? phrase.text.trim() : '')
    .filter(Boolean)
    .join('\n')
  if (!text) throw new Error('Azure Speech returned no transcription')
  return { text }
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === 'audio/ogg') return 'ogg'
  if (mediaType === 'audio/wav' || mediaType === 'audio/x-wav') return 'wav'
  if (mediaType === 'audio/mpeg') return 'mp3'
  if (mediaType === 'audio/mp4') return 'm4a'
  return 'webm'
}
