import { describe, expect, it } from 'vitest'

import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

import { buildTree } from './tree-model.js'

function executor(overrides: Partial<AttachedExecutor> = {}): AttachedExecutor {
  return {
    executorId: 'ex-1',
    workspaceId: 'ws-1',
    workspaceName: 'alpha',
    tools: [],
    runtime: 'node',
    runtimeVersion: 'v22',
    attachedAt: '2026-07-05T10:00:00.000Z',
    ...overrides,
  }
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'sess-1',
    createdAt: '2026-07-05T10:00:00.000Z',
    eventCount: 0,
    ...overrides,
  }
}

describe('buildTree', () => {
  it('returns [] when there are no executors and no sessions', () => {
    expect(buildTree([], [])).toEqual([])
  })

  it('renders online workspace with no children if no sessions attached to it yet', () => {
    const tree = buildTree([executor()], [])
    expect(tree).toHaveLength(1)
    expect(tree[0]!.workspaceId).toBe('ws-1')
    expect(tree[0]!.online).toBe(true)
    expect(tree[0]!.children).toEqual([])
  })

  it('groups sessions under their workspaceId parent', () => {
    const tree = buildTree(
      [executor()],
      [
        session({ sessionId: 's-a', workspaceId: 'ws-1' }),
        session({ sessionId: 's-b', workspaceId: 'ws-1' }),
      ],
    )
    expect(tree).toHaveLength(1)
    expect(tree[0]!.children.map((c) => c.sessionId)).toEqual(['s-a', 's-b'])
  })

  it('puts sessions with no workspaceId under an Unassigned bucket', () => {
    const tree = buildTree(
      [],
      [session({ sessionId: 'orphan' })],
    )
    expect(tree).toHaveLength(1)
    expect(tree[0]!.workspaceId).toBe(null)
    expect(tree[0]!.name).toBe('Unassigned')
    expect(tree[0]!.online).toBe(false)
    expect(tree[0]!.children.map((c) => c.sessionId)).toEqual(['orphan'])
  })

  it('creates an offline workspace bucket when a session references an unknown workspaceId', () => {
    const tree = buildTree(
      [],
      [
        session({
          sessionId: 's-x',
          workspaceId: 'ws-ghost',
          workspaceName: 'ghost',
        }),
      ],
    )
    expect(tree).toHaveLength(1)
    expect(tree[0]!.workspaceId).toBe('ws-ghost')
    expect(tree[0]!.online).toBe(false)
    expect(tree[0]!.name).toBe('ghost')
  })

  it('sorts online workspaces before offline ones, and Unassigned last', () => {
    const tree = buildTree(
      [executor({ workspaceId: 'ws-online', workspaceName: 'zulu' })],
      [
        session({ sessionId: 's-a', workspaceId: 'ws-online' }),
        session({
          sessionId: 's-b',
          workspaceId: 'ws-offline',
          workspaceName: 'alpha',
        }),
        session({ sessionId: 's-c' }),
      ],
    )
    expect(tree.map((n) => n.name)).toEqual(['zulu', 'alpha', 'Unassigned'])
  })

  it('sorts sessions within a workspace by lastActivity desc, using createdAt as fallback', () => {
    // 3 sessions triggers time-bucketing; pin "now" so all fall into today.
    const now = () => Date.parse('2026-07-05T23:00:00.000Z')
    const tree = buildTree(
      [executor()],
      [
        session({
          sessionId: 'old',
          workspaceId: 'ws-1',
          lastEventAt: '2026-07-05T01:00:00.000Z',
        }),
        session({
          sessionId: 'new',
          workspaceId: 'ws-1',
          lastEventAt: '2026-07-05T22:00:00.000Z',
        }),
        session({
          sessionId: 'mid-created-only',
          workspaceId: 'ws-1',
          createdAt: '2026-07-05T12:00:00.000Z',
        }),
      ],
      { now },
    )
    const [first] = tree[0]!.children
    expect(first?.kind).toBe('bucket')
    expect((first as { children: { sessionId: string }[] }).children.map((c) => c.sessionId)).toEqual([
      'new',
      'mid-created-only',
      'old',
    ])
  })

  it('uses firstUserMessage-based label with 40-char cap, and fallback when missing', () => {
    const tree = buildTree(
      [executor()],
      [
        session({
          sessionId: 's-labeled',
          workspaceId: 'ws-1',
          firstUserMessage:
            'please write a really really really really really long letter',
        }),
        session({ sessionId: 'aaaaaabbbbbb', workspaceId: 'ws-1' }),
      ],
    )
    const labels = tree[0]!.children.map((c) => c.label)
    // 40-char truncation with ellipsis
    expect(labels).toContain(
      'please write a really really really real…',
    )
    // No firstUserMessage → falls back to `new session · <6 chars>`
    expect(labels).toContain('new session · aaaaaa')
  })

  it('keeps children flat when a workspace has fewer than 3 sessions', () => {
    const tree = buildTree(
      [executor()],
      [
        session({ sessionId: 's-1', workspaceId: 'ws-1' }),
        session({ sessionId: 's-2', workspaceId: 'ws-1' }),
      ],
    )
    for (const c of tree[0]!.children) {
      expect(c.kind).toBe('session')
    }
  })

  it('buckets sessions by activity age relative to injected now', () => {
    const now = () => Date.parse('2026-07-05T12:00:00.000Z')
    const tree = buildTree(
      [executor()],
      [
        session({
          sessionId: 't-today',
          workspaceId: 'ws-1',
          lastEventAt: '2026-07-05T10:00:00.000Z',
        }),
        session({
          sessionId: 't-yesterday',
          workspaceId: 'ws-1',
          lastEventAt: '2026-07-04T10:00:00.000Z',
        }),
        session({
          sessionId: 't-last7',
          workspaceId: 'ws-1',
          lastEventAt: '2026-07-01T10:00:00.000Z',
        }),
        session({
          sessionId: 't-last30',
          workspaceId: 'ws-1',
          lastEventAt: '2026-06-20T10:00:00.000Z',
        }),
        session({
          sessionId: 't-older',
          workspaceId: 'ws-1',
          lastEventAt: '2026-05-01T10:00:00.000Z',
        }),
      ],
      { now },
    )
    const kids = tree[0]!.children
    expect(kids.every((c) => c.kind === 'bucket')).toBe(true)
    const shape = kids.map((b) => {
      if (b.kind !== 'bucket') throw new Error('unreachable')
      return [b.bucket, b.children.map((c) => c.sessionId)]
    })
    expect(shape).toEqual([
      ['today', ['t-today']],
      ['yesterday', ['t-yesterday']],
      ['last7', ['t-last7']],
      ['last30', ['t-last30']],
      ['older', ['t-older']],
    ])
  })

  it('skips empty buckets in the output', () => {
    const now = () => Date.parse('2026-07-05T12:00:00.000Z')
    const tree = buildTree(
      [executor()],
      [
        session({
          sessionId: 't-1',
          workspaceId: 'ws-1',
          lastEventAt: '2026-07-05T10:00:00.000Z',
        }),
        session({
          sessionId: 't-2',
          workspaceId: 'ws-1',
          lastEventAt: '2026-07-05T09:00:00.000Z',
        }),
        session({
          sessionId: 't-3',
          workspaceId: 'ws-1',
          lastEventAt: '2026-05-01T10:00:00.000Z',
        }),
      ],
      { now },
    )
    const kids = tree[0]!.children
    expect(kids.length).toBe(2)
    if (kids[0]!.kind !== 'bucket' || kids[1]!.kind !== 'bucket') {
      throw new Error('expected buckets')
    }
    expect(kids[0]!.bucket).toBe('today')
    expect(kids[1]!.bucket).toBe('older')
  })
})
