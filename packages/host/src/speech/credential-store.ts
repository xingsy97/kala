import { KalaStateStore } from '../store/state-store.js'

export const DEFAULT_AZURE_SPEECH_ENDPOINT = 'https://japaneast.api.cognitive.microsoft.com/'
export type SpeechTranscriptionMode = 'realtime' | 'after_recording'

export type AzureSpeechCredential = {
  apiKey: string
  endpoint: string
  region: string
  enabled: boolean
  mode: SpeechTranscriptionMode
}

export type AzureSpeechCredentialStatus = {
  configured: boolean
  provider: 'azure'
  endpoint: string
  region: string
  enabled: boolean
  mode: SpeechTranscriptionMode
  updatedAt?: string
}

export interface AzureSpeechCredentialStore {
  get(): Promise<AzureSpeechCredential | undefined> | AzureSpeechCredential | undefined
  status(): Promise<AzureSpeechCredentialStatus> | AzureSpeechCredentialStatus
  set(input: { endpoint: string; apiKey?: string; enabled: boolean; mode: SpeechTranscriptionMode }): Promise<AzureSpeechCredentialStatus> | AzureSpeechCredentialStatus
  delete(): Promise<AzureSpeechCredentialStatus> | AzureSpeechCredentialStatus
}

export function normalizeAzureSpeechEndpoint(raw: string): { endpoint: string; region: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('endpoint must be a valid HTTPS Azure Speech regional endpoint')
  }
  const match = /^([a-z0-9-]+)\.api\.cognitive\.microsoft\.com$/u.exec(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('endpoint must match https://<region>.api.cognitive.microsoft.com/')
  }
  return { endpoint: `https://${url.hostname.toLowerCase()}/`, region: match[1]! }
}

export class LocalAzureSpeechCredentialStore implements AzureSpeechCredentialStore {
  private readonly state: KalaStateStore

  constructor(directory: string | KalaStateStore, keyPath?: string) {
    this.state = typeof directory === 'string'
      ? new KalaStateStore(directory, {
          ...(keyPath ? { keyPath } : {}),
          legacyCredentialDirectory: directory,
        })
      : directory
  }

  async status(): Promise<AzureSpeechCredentialStatus> {
    const record = this.state.getCredential('azure_speech')
    return record ? statusFromRecord(record) : unconfiguredStatus()
  }

  async get(): Promise<AzureSpeechCredential | undefined> {
    const record = this.state.getCredential('azure_speech')
    if (!record) return undefined
    const status = statusFromRecord(record)
    return {
      apiKey: record.secret,
      endpoint: status.endpoint,
      region: status.region,
      enabled: status.enabled,
      mode: status.mode,
    }
  }

  async set(input: { endpoint: string; apiKey?: string; enabled: boolean; mode: SpeechTranscriptionMode }): Promise<AzureSpeechCredentialStatus> {
    const { endpoint, region } = normalizeAzureSpeechEndpoint(input.endpoint)
    const existing = await this.get()
    const apiKey = input.apiKey ?? existing?.apiKey
    if (!apiKey) throw new Error('an Azure Speech key is required')
    const updatedAt = new Date().toISOString()
    this.state.setCredential('azure_speech', apiKey, {
      version: 1,
      provider: 'azure',
      endpoint,
      region,
      enabled: input.enabled,
      mode: input.mode,
    }, updatedAt)
    return { configured: true, provider: 'azure', endpoint, region, enabled: input.enabled, mode: input.mode, updatedAt }
  }

  async delete(): Promise<AzureSpeechCredentialStatus> {
    this.state.deleteCredential('azure_speech')
    return unconfiguredStatus()
  }
}

function statusFromRecord(record: { metadata: Record<string, unknown>; updatedAt: string }): AzureSpeechCredentialStatus {
  const endpoint = typeof record.metadata.endpoint === 'string' ? record.metadata.endpoint : DEFAULT_AZURE_SPEECH_ENDPOINT
  const normalized = normalizeAzureSpeechEndpoint(endpoint)
  return {
    configured: true,
    provider: 'azure',
    endpoint: normalized.endpoint,
    region: typeof record.metadata.region === 'string' ? record.metadata.region : normalized.region,
    enabled: record.metadata.enabled === true,
    mode: record.metadata.mode === 'after_recording' ? 'after_recording' : 'realtime',
    updatedAt: record.updatedAt,
  }
}

function unconfiguredStatus(): AzureSpeechCredentialStatus {
  const { endpoint, region } = normalizeAzureSpeechEndpoint(DEFAULT_AZURE_SPEECH_ENDPOINT)
  return { configured: false, provider: 'azure', endpoint, region, enabled: false, mode: 'realtime' }
}
