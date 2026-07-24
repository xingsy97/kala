import type { ModelInfo } from '@agent-kernel/shared'

const ANTHROPIC_STANDARD_CONTEXT_WINDOW = 200_000
const ANTHROPIC_1M_CONTEXT_WINDOW = 1_000_000
const OPENAI_400K_CONTEXT_WINDOW = 400_000

/**
 * Resolve context metadata that is intrinsic to a known model family.
 * Operator/provider metadata remains authoritative and is applied before this
 * fallback by `resolveModelContextWindow`.
 */
export function knownContextWindow(modelRefOrId: string): number | undefined {
  const model = modelIdFromRef(modelRefOrId).toLowerCase()

  if (isClaudeModel(model)) {
    if (isExplicitClaude1mVariant(model) || isAnthropicGa1mModel(model)) {
      return ANTHROPIC_1M_CONTEXT_WINDOW
    }
    return ANTHROPIC_STANDARD_CONTEXT_WINDOW
  }

  if (model.includes('gpt-5.5')) return OPENAI_400K_CONTEXT_WINDOW
  return undefined
}

/**
 * Resolve a model's effective context window from the live catalog. Exact
 * provider metadata wins. When the same provider-native model id is exposed
 * through another compatible endpoint, reuse the conservative known value
 * from that id instead of losing the capability at the provider boundary.
 */
export function resolveModelContextWindow(
  modelRefOrId: string,
  models: readonly ModelInfo[],
): number | undefined {
  const selected = modelRefOrId.trim()
  if (!selected) return undefined

  const exact = models.find((model) => (model.ref ?? model.id) === selected)
  if (exact?.contextWindow) return exact.contextWindow

  const modelId = exact?.id ?? modelIdFromRef(selected)
  const catalogWindows = models
    .filter((model) => model.id === modelId && model.contextWindow !== undefined)
    .map((model) => model.contextWindow!)
  if (catalogWindows.length > 0) return Math.min(...catalogWindows)

  return knownContextWindow(modelId)
}

export function modelIdFromRef(modelRefOrId: string): string {
  const selected = modelRefOrId.trim()
  const separator = selected.indexOf(':')
  return separator > 0 ? selected.slice(separator + 1) : selected
}

function isClaudeModel(model: string): boolean {
  return /(?:^|[./:_-])claude(?:[./:_-]|$)/.test(model)
}

function isExplicitClaude1mVariant(model: string): boolean {
  return /(?:\[1m\]|(?:^|[._-])1m(?:[._-]|$))/.test(model)
}

function isAnthropicGa1mModel(model: string): boolean {
  return /claude-(?:opus-4[.-](?:6|7|8)|sonnet-4[.-]6)(?:[._-]|$)/.test(model)
}
