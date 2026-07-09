import { describe, expect, it } from 'vitest'

import { checksumFor, normalizeTag } from './update.js'

describe('executor update helpers', () => {
  it('finds the checksum for the executor release asset', () => {
    const sums = [
      'aaa111  agent-kernel-host.cjs',
      'bbb222  agent-kernel-executor.cjs',
      'ccc333  run.sh',
    ].join('\n')

    expect(checksumFor(sums, 'agent-kernel-executor.cjs')).toBe('bbb222')
    expect(checksumFor(sums, 'missing.cjs')).toBeNull()
  })

  it('normalizes update tags while treating latest as unknown', () => {
    expect(normalizeTag(' v0.1.1 ')).toBe('v0.1.1')
    expect(normalizeTag('latest')).toBeNull()
    expect(normalizeTag(undefined)).toBeNull()
  })
})
