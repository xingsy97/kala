export type ContextWindowSource =
  | 'manual_config'
  | 'model_registry'
  | 'provider_default'
  | 'api_reported'
  | 'unknown'

export type ContextUsageSnapshot = {
  model: {
    ref: string
    provider?: string
    id?: string
  }
  contextWindow: {
    tokens: number | null
    source: ContextWindowSource
  }
  usage: {
    inputTokens: number
    outputTokens?: number
    totalTokens: number
  }
  breakdown: {
    system: number
    transcript: number
    tools: number
    memory: number
    attachments: number
    pendingUserInput: number
  }
  estimator: {
    total: {
      kind: 'provider_reported' | 'tokenizer' | 'heuristic'
      confidence: 'exact' | 'estimated' | 'rough'
    }
    breakdown: {
      kind: 'tokenizer' | 'heuristic'
      confidence: 'estimated' | 'rough'
    }
    version: string
  }
  updatedAt: number
}

