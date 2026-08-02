import { describe, expect, it } from 'vitest'
import { FULL_RUNTIME_CAPABILITIES, SAAS_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'

import { disabledEnhancementCapability } from './runtime-capabilities.js'

describe('disabledEnhancementCapability', () => {
  it.each([
    ['benchmark-run-create', 'benchmarks'],
    ['swebench-grade-command', 'benchmarks'],
    ['terminal-bench-run-agent', 'benchmarks'],
    ['program-bench-import-results', 'benchmarks'],
    ['swe-marathon-run-agent', 'benchmarks'],
    ['legacy-swebench-import', 'benchmarks'],
    ['eval-score-session', 'evaluations'],
    ['badcase-list', 'evaluations'],
    ['rollout-verify-reward', 'evaluations'],
  ] as const)('blocks %s in SaaS', (action, capability) => {
    expect(disabledEnhancementCapability(action, SAAS_RUNTIME_CAPABILITIES)).toBe(capability)
  })

  it.each(['enqueue-user-message', 'memory-index', 'reliability-audit-session', 'trace-export-session'])('preserves Agent-supporting action %s', (action) => {
    expect(disabledEnhancementCapability(action, SAAS_RUNTIME_CAPABILITIES)).toBeNull()
  })

  it('allows all actions in Standalone', () => {
    expect(disabledEnhancementCapability('benchmark-run-create', FULL_RUNTIME_CAPABILITIES)).toBeNull()
  })
})
