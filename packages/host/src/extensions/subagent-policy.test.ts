import { describe, expect, it } from 'vitest'

import {
  getSubAgentRoleTemplate,
  isSubAgentRole,
  resolveSubAgentPolicy,
  SUB_AGENT_ROLE_TEMPLATES,
} from '@agent-kernel/shared/enhancement'

describe('resolveSubAgentPolicy', () => {
  it('returns an empty policy with no reasons when input is undefined', () => {
    const policy = resolveSubAgentPolicy({})
    expect(policy.reasons).toEqual([])
    expect(policy.role).toBeUndefined()
    expect(policy.allowedTools).toBeUndefined()
  })

  it('applies the research role template as defaults', () => {
    const policy = resolveSubAgentPolicy({ input: { role: 'research' } })
    expect(policy.role).toBe('research')
    expect(policy.reasons).toContain('role_template_applied')
    expect(policy.allowedTools).toEqual(SUB_AGENT_ROLE_TEMPLATES.research.defaultAllowedTools)
    expect(policy.maxTurns).toBe(SUB_AGENT_ROLE_TEMPLATES.research.defaultMaxTurns)
    expect(policy.timeoutMs).toBe(SUB_AGENT_ROLE_TEMPLATES.research.defaultTimeoutMs)
    expect(policy.expectedOutput).toBe(SUB_AGENT_ROLE_TEMPLATES.research.defaultExpectedOutput)
  })

  it('caps caller-supplied maxTurns and timeoutMs at the template ceiling', () => {
    const policy = resolveSubAgentPolicy({
      input: {
        role: 'review',
        maxTurns: 999,
        timeoutMs: 60 * 60_000,
      },
    })
    expect(policy.maxTurns).toBe(SUB_AGENT_ROLE_TEMPLATES.review.defaultMaxTurns)
    expect(policy.timeoutMs).toBe(SUB_AGENT_ROLE_TEMPLATES.review.defaultTimeoutMs)
    expect(policy.reasons).toContain('policy_max_turns_capped')
    expect(policy.reasons).toContain('policy_timeout_capped')
  })

  it('intersects explicit allowedTools with template defaults', () => {
    const policy = resolveSubAgentPolicy({
      input: {
        role: 'research',
        allowedTools: ['read', 'bash', 'unknown_tool'],
      },
    })
    expect(policy.allowedTools).toEqual(['read'])
    expect(policy.reasons).toContain('policy_allowed_tools_intersected')
  })

  it('intersects allowedTools with parent-available tools', () => {
    const policy = resolveSubAgentPolicy({
      input: { role: 'test' },
      parentTools: ['read', 'ls'],
    })
    expect(policy.allowedTools).toEqual(['read', 'ls'])
    expect(policy.reasons).toContain('policy_allowed_tools_intersected')
  })

  it('marks unknown roles', () => {
    const policy = resolveSubAgentPolicy({
      input: { role: 'unknown' as unknown as 'research' },
    })
    expect(policy.reasons).toContain('role_unknown')
    expect(policy.reasons).not.toContain('role_template_applied')
  })

  it('preserves explicit values below the template ceilings', () => {
    const policy = resolveSubAgentPolicy({
      input: { role: 'test', maxTurns: 5, timeoutMs: 30_000 },
    })
    expect(policy.maxTurns).toBe(5)
    expect(policy.timeoutMs).toBe(30_000)
    expect(policy.reasons).not.toContain('policy_max_turns_capped')
    expect(policy.reasons).not.toContain('policy_timeout_capped')
  })

  it('records depth cap when parent depth reaches max depth', () => {
    const policy = resolveSubAgentPolicy({ parentDepth: 3, maxDepth: 3 })
    expect(policy.resolvedDepth).toBe(3)
    expect(policy.maxDepth).toBe(3)
    expect(policy.reasons).toContain('policy_max_depth_exceeded')
  })

  it('leaves depth reason clean under the cap', () => {
    const policy = resolveSubAgentPolicy({ parentDepth: 1, maxDepth: 3 })
    expect(policy.resolvedDepth).toBe(1)
    expect(policy.maxDepth).toBe(3)
    expect(policy.reasons).not.toContain('policy_max_depth_exceeded')
  })

  it('records fan-out cap when concurrent siblings reach max fan-out', () => {
    const policy = resolveSubAgentPolicy({ concurrentSiblingCount: 4, maxFanOut: 4 })
    expect(policy.concurrentSiblingCount).toBe(4)
    expect(policy.maxFanOut).toBe(4)
    expect(policy.reasons).toContain('policy_max_fanout_exceeded')
  })

  it('leaves fan-out reason clean under the cap', () => {
    const policy = resolveSubAgentPolicy({ concurrentSiblingCount: 1, maxFanOut: 4 })
    expect(policy.concurrentSiblingCount).toBe(1)
    expect(policy.maxFanOut).toBe(4)
    expect(policy.reasons).not.toContain('policy_max_fanout_exceeded')
  })
})

describe('SubAgent role registry', () => {
  it('exposes deterministic templates for each role', () => {
    for (const role of ['research', 'test', 'review'] as const) {
      const template = getSubAgentRoleTemplate(role)
      expect(template).toBeDefined()
      expect(template?.role).toBe(role)
      expect(template?.defaultAllowedTools.length).toBeGreaterThan(0)
    }
  })

  it('rejects non-role strings', () => {
    expect(isSubAgentRole('research')).toBe(true)
    expect(isSubAgentRole('build')).toBe(false)
    expect(isSubAgentRole(42)).toBe(false)
  })
})
