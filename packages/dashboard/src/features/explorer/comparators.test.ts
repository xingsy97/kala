import { describe, expect, it } from 'vitest'

import {
  coarseSummaryStatus,
  isSessionWorkspaceOnline,
  sameExecutorListForExplorer,
  sameSessionListForExplorer,
  sameSessionStatusMap,
} from './comparators.js'

describe('coarseSummaryStatus', () => {
  it('collapses running-ish statuses and passes others through', () => {
    // Running statuses should map to a single coarse value; resting ones stay.
    const running = coarseSummaryStatus('thinking' as never)
    const idle = coarseSummaryStatus('idle' as never)
    expect(typeof running).toBe('string')
    expect(idle).toBe('idle')
    expect(coarseSummaryStatus(undefined)).toBeTypeOf('string')
  })
})

describe('isSessionWorkspaceOnline', () => {
  it('is true only when the session workspace id is in the online set', () => {
    const node = { workspaceId: 'w1' } as never
    expect(isSessionWorkspaceOnline(node, new Set(['w1']))).toBe(true)
    expect(isSessionWorkspaceOnline(node, new Set(['w2']))).toBe(false)
  })
})

describe('sameExecutorListForExplorer', () => {
  it('is true for identical lists and false when an id changes', () => {
    const a = [{ executorId: 'e1' }, { executorId: 'e2' }] as never
    const b = [{ executorId: 'e1' }, { executorId: 'e2' }] as never
    const c = [{ executorId: 'e1' }, { executorId: 'x' }] as never
    expect(sameExecutorListForExplorer(a, b)).toBe(true)
    expect(sameExecutorListForExplorer(a, c)).toBe(false)
    expect(sameExecutorListForExplorer(a, [{ executorId: 'e1' }] as never)).toBe(false)
  })
})

describe('sameSessionListForExplorer', () => {
  it('detects length and coarse-status changes', () => {
    const a = [{ sessionId: 's1', status: 'idle', label: 'L' }] as never
    const same = [{ sessionId: 's1', status: 'idle', label: 'L' }] as never
    const diff = [{ sessionId: 's1', status: 'error', label: 'L' }] as never
    expect(sameSessionListForExplorer(a, same)).toBe(true)
    expect(sameSessionListForExplorer(a, diff)).toBe(false)
  })
})

describe('sameSessionStatusMap', () => {
  it('compares two status maps by entries', () => {
    const a = new Map([['s1', 'idle']]) as never
    const same = new Map([['s1', 'idle']]) as never
    const diff = new Map([['s1', 'loading']]) as never
    expect(sameSessionStatusMap(a, same)).toBe(true)
    expect(sameSessionStatusMap(a, diff)).toBe(false)
  })
})
