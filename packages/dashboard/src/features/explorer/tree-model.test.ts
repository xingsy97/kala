import { describe, expect, it } from 'vitest'

import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

import {
  applyManualSessionOrder,
  applyManualWorkspaceOrder,
  buildInitialOpenState,
  buildTree,
  canDropWorkspacesAtRoot,
  countSessionDescendants,
  filterTree,
  reorderSessionIds,
  reorderWorkspaceIds,
  runtimeMetaFor,
  sessionStructureKeyFor,
  syncSessionOrder,
  syncWorkspaceOrder,
  toStructuralSessionSummary,
} from './tree-model.js'

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

  it('puts sessions with no workspaceId under the supported Chats bucket', () => {
    const tree = buildTree(
      [],
      [session({ sessionId: 'orphan' })],
    )
    expect(tree).toHaveLength(1)
    expect(tree[0]!.workspaceId).toBe(null)
    expect(tree[0]!.name).toBe('Chats')
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

  it('sorts Chats before online and offline workspaces', () => {
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
    expect(tree.map((n) => n.name)).toEqual(['Chats', 'zulu', 'alpha'])
  })

  it('keeps sessions in incoming order so activity does not move cards to the top', () => {
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
    )
    expect(tree[0]!.children.map((c) => c.sessionId)).toEqual([
      'old',
      'new',
      'mid-created-only',
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

  it('keeps children flat regardless of session count', () => {
    const tree = buildTree(
      [executor()],
      [
        session({ sessionId: 's-1', workspaceId: 'ws-1' }),
        session({ sessionId: 's-2', workspaceId: 'ws-1' }),
        session({ sessionId: 's-3', workspaceId: 'ws-1' }),
        session({ sessionId: 's-4', workspaceId: 'ws-1' }),
      ],
    )
    for (const c of tree[0]!.children) {
      expect(c.kind).toBe('session')
    }
  })

  it('nests a fork under its parent instead of surfacing it as a sibling', () => {
    const tree = buildTree(
      [executor()],
      [
        session({ sessionId: 'parent', workspaceId: 'ws-1' }),
        session({
          sessionId: 'child',
          workspaceId: 'ws-1',
          parentSessionId: 'parent',
        }),
      ],
    )
    // Two sessions total but only the parent shows at the workspace level.
    expect(tree[0]!.children).toHaveLength(1)
    const parentNode = tree[0]!.children[0]!
    if (parentNode.kind !== 'session') throw new Error('expected session')
    expect(parentNode.sessionId).toBe('parent')
    expect(parentNode.children.map((c) => c.sessionId)).toEqual(['child'])
  })

  it('nests a multi-level fork chain (fork of a fork)', () => {
    const tree = buildTree(
      [executor()],
      [
        session({ sessionId: 'root', workspaceId: 'ws-1' }),
        session({
          sessionId: 'child',
          workspaceId: 'ws-1',
          parentSessionId: 'root',
        }),
        session({
          sessionId: 'grandchild',
          workspaceId: 'ws-1',
          parentSessionId: 'child',
        }),
      ],
    )
    expect(tree[0]!.children).toHaveLength(1)
    const root = tree[0]!.children[0]!
    if (root.kind !== 'session') throw new Error('expected session')
    expect(root.sessionId).toBe('root')
    expect(root.children).toHaveLength(1)
    const child = root.children[0]!
    expect(child.sessionId).toBe('child')
    expect(child.children.map((c) => c.sessionId)).toEqual(['grandchild'])
  })

  it('treats a fork whose parent is missing as a root of its workspace', () => {
    // Parent was deleted or lives in a workspace that has no attached
    // executor — the child should still be visible, not silently hidden.
    const tree = buildTree(
      [executor()],
      [
        session({
          sessionId: 'orphan-fork',
          workspaceId: 'ws-1',
          parentSessionId: 'ghost-parent',
        }),
      ],
    )
    expect(tree[0]!.children).toHaveLength(1)
    const node = tree[0]!.children[0]!
    if (node.kind !== 'session') throw new Error('expected session')
    expect(node.sessionId).toBe('orphan-fork')
    expect(node.children).toEqual([])
  })

  it('treats a fork whose parent lives in a different workspace as a root', () => {
    // Cross-workspace forks are rare but possible if a session is moved.
    // Keep the fork visible in its own workspace rather than nesting
    // under a parent that isn't in the same tree.
    const tree = buildTree(
      [
        executor({ workspaceId: 'ws-a', workspaceName: 'alpha' }),
        executor({ executorId: 'ex-2', workspaceId: 'ws-b', workspaceName: 'bravo' }),
      ],
      [
        session({ sessionId: 'parent', workspaceId: 'ws-a' }),
        session({
          sessionId: 'child',
          workspaceId: 'ws-b',
          parentSessionId: 'parent',
        }),
      ],
    )
    const alpha = tree.find((n) => n.workspaceId === 'ws-a')!
    const bravo = tree.find((n) => n.workspaceId === 'ws-b')!
    expect(alpha.children.map((c) => c.sessionId)).toEqual(['parent'])
    expect(bravo.children.map((c) => c.sessionId)).toEqual(['child'])
  })

  it('keeps fork roots flat with their children', () => {
    // Three sessions total, but two are forks under a single root. Parent +
    // its forks stay flat.
    const tree = buildTree(
      [executor()],
      [
        session({
          sessionId: 'root',
          workspaceId: 'ws-1',
          lastEventAt: '2026-07-05T10:00:00.000Z',
        }),
        session({
          sessionId: 'fork-1',
          workspaceId: 'ws-1',
          parentSessionId: 'root',
          lastEventAt: '2026-07-05T11:00:00.000Z',
        }),
        session({
          sessionId: 'fork-2',
          workspaceId: 'ws-1',
          parentSessionId: 'root',
          lastEventAt: '2026-07-05T12:00:00.000Z',
        }),
      ],
    )
    expect(tree[0]!.children).toHaveLength(1)
    const node = tree[0]!.children[0]!
    expect(node.kind).toBe('session')
    if (node.kind !== 'session') throw new Error('unreachable')
    // Forks keep the incoming order so activity does not reshuffle rows.
    expect(node.children.map((c) => c.sessionId)).toEqual(['fork-1', 'fork-2'])
  })
})

describe('explorer tree model helpers', () => {
  it('syncs workspace order against live non-unassigned workspaces', () => {
    const tree = buildTree(
      [
        executor({ workspaceId: 'ws-a', workspaceName: 'alpha' }),
        executor({ executorId: 'ex-2', workspaceId: 'ws-b', workspaceName: 'bravo' }),
      ],
      [session({ sessionId: 'orphan' })],
    )

    expect(syncWorkspaceOrder(['deleted', 'ws-b'], tree)).toEqual(['ws-b', 'ws-a'])
    expect(applyManualWorkspaceOrder(tree, ['ws-b', 'ws-a']).map((node) => node.workspaceId)).toEqual(['ws-b', 'ws-a', null])
    expect(reorderWorkspaceIds(['ws-a', 'ws-b'], ['ws-a', 'ws-b'], ['ws-b'], 0)).toEqual(['ws-b', 'ws-a'])
  })

  it('syncs and reorders sessions only inside the target workspace slice', () => {
    const sessions = [
      session({ sessionId: 's-1', workspaceId: 'ws-a' }),
      session({ sessionId: 's-2', workspaceId: 'ws-a' }),
      session({ sessionId: 's-3', workspaceId: 'ws-b' }),
    ]

    expect(syncSessionOrder(['gone', 's-2'], sessions)).toEqual(['s-2', 's-1', 's-3'])
    expect(applyManualSessionOrder(sessions, ['s-2', 's-1', 's-3']).map((item) => item.sessionId)).toEqual(['s-2', 's-1', 's-3'])
    expect(reorderSessionIds(['s-1', 's-2', 's-3'], ['s-1', 's-2'], ['s-2'], 0)).toEqual(['s-2', 's-1', 's-3'])
  })

  it('builds initial open state with workspaces open and fork sessions closed by default', () => {
    const tree = buildTree(
      [executor()],
      [
        session({ sessionId: 'parent', workspaceId: 'ws-1' }),
        session({ sessionId: 'child', workspaceId: 'ws-1', parentSessionId: 'parent' }),
      ],
    )

    expect(buildInitialOpenState(tree, {}, {})).toEqual({
      'ws:ws-1': true,
      'sess:parent': false,
    })
    expect(buildInitialOpenState(tree, { 'ws:ws-1': false }, { 'sess:parent': true })).toEqual({
      'ws:ws-1': false,
      'sess:parent': true,
    })
  })

  it('filters matching fork descendants while keeping parent context', () => {
    const tree = buildTree(
      [executor()],
      [
        session({ sessionId: 'parent', workspaceId: 'ws-1', firstUserMessage: 'root task' }),
        session({ sessionId: 'child', workspaceId: 'ws-1', parentSessionId: 'parent', firstUserMessage: 'needle task' }),
      ],
    )

    const filtered = filterTree(tree, 'needle')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.children.map((node) => node.sessionId)).toEqual(['parent'])
    expect(filtered[0]!.children[0]!.children.map((node) => node.sessionId)).toEqual(['child'])
  })

  it('counts descendants recursively for cascade delete prompts', () => {
    const tree = buildTree(
      [executor()],
      [
        session({ sessionId: 'root', workspaceId: 'ws-1' }),
        session({ sessionId: 'child', workspaceId: 'ws-1', parentSessionId: 'root' }),
        session({ sessionId: 'grandchild', workspaceId: 'ws-1', parentSessionId: 'child' }),
      ],
    )

    expect(countSessionDescendants(tree[0]!.children[0]!)).toBe(2)
  })

  it('keeps structure derivation stable when runtime-only fields change', () => {
    const base = session({
      sessionId: 's-1',
      workspaceId: 'ws-1',
      label: 'label',
      firstUserMessage: 'hello',
      createdAt: '2026-07-05T10:00:00.000Z',
      status: 'thinking',
      currentCwd: '/one',
      lastEventAt: '2026-07-05T11:00:00.000Z',
      eventCount: 10,
    })
    const changedRuntime = { ...base, status: 'done' as const, currentCwd: '/two', lastEventAt: '2026-07-05T12:00:00.000Z', eventCount: 20 }

    expect(sessionStructureKeyFor(base)).toBe(sessionStructureKeyFor(changedRuntime))
    expect(toStructuralSessionSummary(base)).toEqual({
      sessionId: 's-1',
      createdAt: '2026-07-05T10:00:00.000Z',
      eventCount: 0,
      workspaceId: 'ws-1',
      firstUserMessage: 'hello',
      label: 'label',
    })
    expect(runtimeMetaFor(changedRuntime)).toEqual({
      status: 'done',
      currentCwd: '/two',
      lastActivityIso: '2026-07-05T12:00:00.000Z',
    })
  })

  it('allows only real workspace nodes to drop at the root', () => {
    expect(canDropWorkspacesAtRoot({
      parentNode: { id: '__REACT_ARBORIST_INTERNAL_ROOT__', isRoot: true },
      dragNodes: [{ data: { kind: 'workspace', workspaceId: 'ws-1' } }],
    })).toBe(true)
    expect(canDropWorkspacesAtRoot({
      parentNode: { id: 'ws:ws-2', isRoot: false },
      dragNodes: [{ data: { kind: 'workspace', workspaceId: 'ws-1' } }],
    })).toBe(false)
    expect(canDropWorkspacesAtRoot({
      parentNode: null,
      dragNodes: [{ data: { kind: 'workspace', workspaceId: null } }],
    })).toBe(false)
  })
})
