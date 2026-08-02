import type { LLMAdapter } from './adapter.js'
import { anthropicAdapter } from './anthropic.js'
import { openaiAdapter } from './openai.js'

export type LLMProviderConfig = {
  id: string
  wire: 'openai' | 'anthropic'
  model: string
  baseUrl: string
  credentialRef: string
}
export interface SecretResolver { resolve(reference: string): Promise<string> }
export interface LLMClientFactory { create(config: LLMProviderConfig): Promise<LLMAdapter> }

export class ExplicitLLMClientFactory implements LLMClientFactory {
  constructor(private readonly secrets: SecretResolver) {}
  async create(config: LLMProviderConfig): Promise<LLMAdapter> {
    const apiKey = await this.secrets.resolve(config.credentialRef)
    if (!apiKey) throw new Error(`LLM credential reference could not be resolved: ${config.credentialRef}`)
    return config.wire === 'anthropic'
      ? anthropicAdapter({ apiKey, model: config.model, apiUrl: `${config.baseUrl.replace(/\/$/u, '')}/v1/messages` })
      : openaiAdapter({ apiKey, model: config.model, baseUrl: config.baseUrl })
  }
}

export class EnvironmentSecretResolver implements SecretResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}
  async resolve(reference: string): Promise<string> {
    const name = reference.startsWith('env:') ? reference.slice(4) : reference
    const value = this.environment[name]?.trim()
    if (!value) throw new Error(`required secret environment variable is missing: ${name}`)
    return value
  }
}
