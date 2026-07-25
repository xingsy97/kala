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
    /**
     * Optional second-level split of `transcript` by message role. When
     * present, `userMessages + assistantMessages + toolResults` approximates
     * `transcript` (they use the same estimator over role-partitioned
     * messages). Consumers must treat this as optional for backwards compat.
     */
    transcriptBreakdown?: {
      userMessages: number
      assistantMessages: number
      toolResults: number
    }
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

