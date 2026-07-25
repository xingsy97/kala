import { describe, expect, it } from 'vitest'

import { isSkillTool, subAgentRelationSummary } from './detail-model.js'

describe('isSkillTool', () => {
  it('detects the skill tool by name', () => {
    expect(isSkillTool({ name: 'skill' } as never)).toBe(true)
    expect(isSkillTool({ name: 'bash' } as never)).toBe(false)
  })
})

describe('subAgentRelationSummary', () => {
  it('counts agent tool calls by lifecycle state', () => {
    const calls = [
      { name: 'agent', result: { ok: true } },
      { name: 'agent', result: { ok: false } },
      { name: 'agent' }, // running (no result)
      { name: 'bash', result: { ok: true } }, // ignored
    ] as never
    const s = subAgentRelationSummary('parent-1', 5, calls)
    expect(s.parentSessionId).toBe('parent-1')
    expect(s.parentCursor).toBe(5)
    expect(s.total).toBe(3)
    expect(s.completed).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.running).toBe(1)
  })
})
