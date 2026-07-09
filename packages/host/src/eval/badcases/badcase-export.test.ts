import { describe, expect, it } from 'vitest'

import type { BadCase } from './badcase-mining.js'
import { exportForRL, exportForSFT } from './badcase-export.js'

const sample: BadCase[] = [
  {
    instanceId: 'a',
    failureCategory: 'patch-apply-failure',
    traceHead: ['h1'],
    traceTail: ['t1'],
    toolCallErrors: ['e1'],
    verifierReason: 'diff did not apply',
  },
  {
    instanceId: 'b',
    failureCategory: 'test-timeout',
    traceHead: [],
    traceTail: [],
    toolCallErrors: [],
  },
]

describe('exportForSFT', () => {
  it('produces one JSON per line with instruction+trace+optional gold', () => {
    const jsonl = exportForSFT(sample)
    const lines = jsonl.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      instruction: expect.stringContaining('a'),
      trace: { head: ['h1'], tail: ['t1'], toolCallErrors: ['e1'] },
      gold: 'diff did not apply',
    })
    expect(lines[1]).not.toHaveProperty('gold')
  })
  it('returns empty string for empty input', () => {
    expect(exportForSFT([])).toBe('')
  })
})

describe('exportForRL', () => {
  it('produces {prompt, rollout, reward:0, reason}', () => {
    const jsonl = exportForRL(sample)
    const lines = jsonl.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({
      prompt: expect.stringContaining('a'),
      rollout: { head: ['h1'], tail: ['t1'], toolCallErrors: ['e1'] },
      reward: 0,
      reason: 'patch-apply-failure',
    })
    expect(lines[1]!.reward).toBe(0)
    expect(lines[1]!.reason).toBe('test-timeout')
  })
})
