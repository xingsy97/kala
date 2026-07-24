import type { ModelInfo } from '@agent-kernel/shared'
import { describe, expect, it } from 'vitest'

import { knownContextWindow, resolveModelContextWindow } from './model-capabilities.js'

describe('knownContextWindow', () => {
  it.each([
    ['anthropic:claude-opus-4.8', 1_000_000],
    ['claude-opus-4-7-1m-internal', 1_000_000],
    ['claude-sonnet-4-6', 1_000_000],
    ['claude-haiku-4-5', 200_000],
    ['gpt-5.5-codex', 400_000],
    ['custom-model', undefined],
  ])('resolves %s to %s', (model, expected) => {
    expect(knownContextWindow(model)).toBe(expected)
  })
})

describe('resolveModelContextWindow', () => {
  const models: ModelInfo[] = [
    { ref: 'primary:gpt-shared', id: 'gpt-shared', label: 'Shared', provider: 'Primary', providerId: 'primary', contextWindow: 353_346 },
    { ref: 'secondary:gpt-shared', id: 'gpt-shared', label: 'Shared', provider: 'Secondary', providerId: 'secondary' },
  ]

  it('uses exact provider metadata first', () => {
    expect(resolveModelContextWindow('primary:gpt-shared', models)).toBe(353_346)
  })

  it('reuses context metadata for the same provider-native model id', () => {
    expect(resolveModelContextWindow('secondary:gpt-shared', models)).toBe(353_346)
  })

  it('keeps truly unknown custom models unknown', () => {
    expect(resolveModelContextWindow('custom:unlisted-model', models)).toBeUndefined()
  })
})
