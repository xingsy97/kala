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
    expect(coarseSummaryStatus('thinking' as never)).toBe('running')
    expect(coarseSummaryStatus('executing_tools' as never)).toBe('running')
    expect(coarseSummaryStatus('idle' as never)).toBe('idle')
    expect(coarseSummaryStatus(undefined)).toBe('unknown')
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
  it('compares two status maps by session and visible status', () => {
    const a = new Map([['s1', 'idle']]) as never
    const same = new Map([['s1', 'idle']]) as never
    const diff = new Map([['s1', 'loading']]) as never
    expect(sameSessionStatusMap(a, same)).toBe(true)
    expect(sameSessionStatusMap(a, diff)).toBe(false)
  })

  it('updates exact labels independently as sessions enter different running phases', () => {
    const loading = new Map([['s1', 'loading'], ['s2', 'thinking']]) as never
    const nextPhase = new Map([['s1', 'executing_tools'], ['s2', 'loading']]) as never
    const wrongSession = new Map([['s1', 'executing_tools'], ['s3', 'loading']]) as never

    expect(sameSessionStatusMap(loading, nextPhase)).toBe(false)
    expect(sameSessionStatusMap(loading, wrongSession)).toBe(false)
  })
})
