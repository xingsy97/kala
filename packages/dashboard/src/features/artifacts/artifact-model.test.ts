import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  arrayLength,
  booleanField,
  formatBytes,
  formatInteger,
  isOpsArtifactKind,
  numberField,
  opsKindOrder,
  stringField,
} from './artifact-model.js'

describe('field accessors', () => {
  const rec = { s: 'x', n: 3, b: true, arr: [1, 2], bad: NaN }
  it('reads typed fields or undefined', () => {
    expect(stringField(rec, 's')).toBe('x')
    expect(stringField(rec, 'n')).toBeUndefined()
    expect(numberField(rec, 'n')).toBe(3)
    expect(numberField(rec, 'bad')).toBeUndefined()
    expect(booleanField(rec, 'b')).toBe(true)
    expect(arrayLength(rec.arr)).toBe(2)
    expect(arrayLength('nope')).toBe(0)
  })
})

describe('formatters', () => {
  it('formatBytes uses B/KB/MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
  it('formatInteger handles non-numbers', () => {
    expect(formatInteger(1234)).toBe('1,234')
    expect(formatInteger('x')).toBe('0')
  })
})

describe('isOpsArtifactKind / opsKindOrder', () => {
  it('recognizes ops kinds and orders them stably', () => {
    expect(isOpsArtifactKind('reliability_audit')).toBe(true)
    expect(isOpsArtifactKind('trace')).toBe(true)
    expect(isOpsArtifactKind('not_a_kind')).toBe(false)
    expect(opsKindOrder('reliability_audit')).toBe(0)
    expect(opsKindOrder('tool_catalog')).toBeGreaterThan(opsKindOrder('reliability_audit'))
  })
})

describe('product artifact language', () => {
  it('does not expose evaluation or benchmark workflow inputs', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/artifacts/product-artifact-views.tsx'), 'utf8')
    expect(source).not.toMatch(/rollout-verify-reward|trialPath|scorePath|benchmark|grader/iu)
    expect(source).toContain('profile,trace,memory_index')
  })
})
