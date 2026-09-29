import { KalaStateStore } from '../store/state-store.js'
import type { WebSearchCredentialStore } from './index.js'

const PROVIDER = 'serper' as const

export type WebSearchCredentialStatus = {
  configured: boolean
  provider: typeof PROVIDER
  updatedAt?: string
}

export class LocalWebSearchCredentialStore implements WebSearchCredentialStore {
  private readonly state: KalaStateStore

  constructor(directory: string | KalaStateStore, keyPath?: string) {
    this.state = typeof directory === 'string'
      ? new KalaStateStore(directory, {
          ...(keyPath ? { keyPath } : {}),
          legacyCredentialDirectory: directory,
        })
      : directory
  }

  async status(): Promise<WebSearchCredentialStatus> {
    const record = this.state.getCredential(PROVIDER)
    return record
      ? { configured: true, provider: PROVIDER, updatedAt: record.updatedAt }
      : { configured: false, provider: PROVIDER }
  }

  async get(provider: typeof PROVIDER): Promise<string | undefined> {
    return provider === PROVIDER ? this.state.getCredential(PROVIDER)?.secret : undefined
  }

  async set(provider: typeof PROVIDER, key: string): Promise<WebSearchCredentialStatus> {
    if (provider !== PROVIDER) throw new Error('unsupported web search provider')
    const updatedAt = new Date().toISOString()
    this.state.setCredential(PROVIDER, key, { version: 1, provider: PROVIDER }, updatedAt)
    return { configured: true, provider: PROVIDER, updatedAt }
  }

  async delete(provider: typeof PROVIDER): Promise<WebSearchCredentialStatus> {
    if (provider !== PROVIDER) throw new Error('unsupported web search provider')
    this.state.deleteCredential(PROVIDER)
    return { configured: false, provider: PROVIDER }
  }
}
