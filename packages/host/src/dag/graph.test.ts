import { describe, expect, it } from 'vitest'

import { assertDag, assertNodeTransition, assertSingleEntryReachability, scopesConflict } from './graph.js'

describe('DAG graph invariants', () => {
  it('accepts an acyclic graph and rejects cycles, unknown nodes, and duplicate edges', () => {
    expect(() => assertDag(['plan', 'build'], [{ source: 'plan', target: 'build' }])).not.toThrow()
    expect(() => assertDag(['a', 'b'], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }])).toThrow('acyclic')
    expect(() => assertDag(['a'], [{ source: 'a', target: 'missing' }])).toThrow('unknown node')
    expect(() => assertDag(['a', 'b'], [{ source: 'a', target: 'b' }, { source: 'a', target: 'b' }])).toThrow('unique')
  })

  it('enforces node transitions and hierarchical write-scope conflicts', () => {
    expect(() => assertNodeTransition('ready', 'running')).not.toThrow()
    expect(() => assertNodeTransition('succeeded', 'running')).toThrow('Cannot transition')
    expect(scopesConflict(['src'], ['src/api/index.ts'])).toBe(true)
    expect(scopesConflict(['docs'], ['src'])).toBe(false)
    expect(() => scopesConflict(['/absolute'], ['/absolute'])).toThrow('Invalid DAG write scope')
    expect(() => scopesConflict(['src/../secret'], ['src/../secret'])).toThrow('Invalid DAG write scope')
  })

  it('requires replacement patches to have one entry reaching every node', () => {
    expect(assertSingleEntryReachability(
      ['entry', 'left', 'right'],
      [{ source: 'entry', target: 'left' }, { source: 'entry', target: 'right' }],
    )).toBe('entry')
    expect(() => assertSingleEntryReachability(['left', 'right'], [])).toThrow('exactly one entry')
  })
})
