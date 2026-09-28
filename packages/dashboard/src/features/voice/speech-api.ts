import { responseError } from '../settings/section-utils.js'

export const DEFAULT_AZURE_SPEECH_ENDPOINT = 'https://japaneast.api.cognitive.microsoft.com/'
export const SPEECH_SETTINGS_CHANGED_EVENT = 'ak:speech-settings-changed'
export type SpeechTranscriptionMode = 'realtime' | 'after_recording'

export type SpeechSettings = {
  configured: boolean
  provider: 'azure'
  endpoint: string
  region: string
  enabled: boolean
  mode: SpeechTranscriptionMode
  updatedAt?: string
}

export type SpeechToken = {
  token: string
  endpoint: string
  region: string
  expiresInSeconds: number
}

export async function loadSpeechSettings(): Promise<SpeechSettings> {
  const response = await fetch('/settings/speech', { cache: 'no-store' })
  if (!response.ok) throw new Error(await responseError(response))
  const settings = await response.json() as Omit<SpeechSettings, 'mode'> & { mode?: unknown }
  return { ...settings, mode: settings.mode === 'after_recording' ? 'after_recording' : 'realtime' }
}

export async function requestSpeechToken(): Promise<SpeechToken> {
  const response = await fetch('/runtime/speech/token', { method: 'POST', cache: 'no-store' })
  if (!response.ok) throw new Error(await responseError(response))
  return (await response.json()) as SpeechToken
}

export async function transcribeSpeechRecording(recording: Blob): Promise<string> {
  const response = await fetch('/runtime/speech/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': recording.type || 'audio/webm' },
    body: recording,
  })
  if (!response.ok) throw new Error(await responseError(response))
  const result = await response.json() as { text?: unknown }
  if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('Voice transcription returned no text')
  return result.text.trim()
}
