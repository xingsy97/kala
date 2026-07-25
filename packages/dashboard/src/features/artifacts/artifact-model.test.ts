import { describe, expect, it } from 'vitest'

import {
  arrayLength,
  booleanField,
  evalRunRoot,
  formatBytes,
  formatDuration,
  formatInteger,
  formatPercent,
  groupTrialArtifacts,
  isOpsArtifactKind,
  mergeEvalRuns,
  numberField,
  opsKindOrder,
  stringField,
  trialInstanceId,
  trialStableId,
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
  it('formatPercent / formatDuration / formatInteger handle non-numbers', () => {
    expect(formatPercent(0.25)).toBe('25%')
    expect(formatPercent('x')).toBe('n/a')
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(120000)).toBe('2m')
    expect(formatDuration(null)).toBe('n/a')
    expect(formatInteger(1234)).toBe('1,234')
    expect(formatInteger('x')).toBe('0')
  })
})


describe('evalRunRoot', () => {
  it('strips known summary/progress filenames', () => {
    expect(evalRunRoot('a/b/summary.json')).toBe('a/b')
    expect(evalRunRoot('a/b/progress.json')).toBe('a/b')
  })
  it('falls back to stripping the last path segment', () => {
    expect(evalRunRoot('a/b/other.json')).toBe('a/b')
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

describe('trialStableId / trialInstanceId', () => {
  const base = { trial: {}, path: 'runs/x/trial-7.json' } as never
  it('prefers trialId, then instanceId, then path', () => {
    expect(trialStableId({ trial: { trialId: 't1', instanceId: 'i1' }, path: 'p' } as never)).toBe('t1')
    expect(trialStableId({ trial: { instanceId: 'i1' }, path: 'p' } as never)).toBe('i1')
    expect(trialStableId(base)).toBe('runs/x/trial-7.json')
  })
  it('derives an instance id from the filename when unset', () => {
    expect(trialInstanceId(base)).toBe('trial-7')
    expect(trialInstanceId({ trial: { instanceId: 'i1' }, path: 'p' } as never)).toBe('i1')
  })
})

describe('mergeEvalRuns', () => {
  it('merges summaries and progresses by run root, newest first', () => {
    const rows = mergeEvalRuns(
      [{ path: 'r/a/summary.json', summary: { s: 1 } } as never],
      [
        { path: 'r/a/progress.json', progress: { updatedAt: '2020-01-01' } } as never,
        { path: 'r/b/progress.json', progress: { updatedAt: '2021-01-01' } } as never,
      ],
    )
    expect(rows).toHaveLength(2)
    // newest (2021 root b) sorts first
    expect(rows[0].root).toBe('r/b')
    const a = rows.find((r) => r.root === 'r/a')
    expect(a?.summary).toEqual({ s: 1 })
    expect(a?.progress).toEqual({ updatedAt: '2020-01-01' })
  })
})

describe('groupTrialArtifacts', () => {
  it('classifies artifacts into ordered categories, resolving relative paths', () => {
    const groups = groupTrialArtifacts('run/root', [
      { uri: 'fix.patch', kind: 'diff' } as never,
      { uri: 'run/root/out.log', kind: 'log' } as never,
    ])
    const cats = groups.map((g) => g.category)
    expect(cats).toContain('patch')
    expect(cats).toContain('log')
    // patch appears before log per the category order
    expect(cats.indexOf('patch')).toBeLessThan(cats.indexOf('log'))
    const patch = groups.find((g) => g.category === 'patch')
    expect(patch?.items[0].path).toBe('run/root/fix.patch')
  })
})
