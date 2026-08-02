import { describe, expect, it } from 'vitest'

import { applyTodoGraphOperations, type TodoGraphSnapshot } from './todo-graph.js'

const empty: TodoGraphSnapshot = {
  version: 1,
  revision: 0,
  nodes: [],
  edges: [],
  summary: { total: 0, completed: 0, active: 0, ready: 0, blocked: 0, cancelled: 0 },
  ready: [],
  blocked: [],
  changed: [],
}

describe('todo graph', () => {
  it('creates branches and derives ready and blocked nodes', () => {
    const graph = applyTodoGraphOperations(empty, [{
      op: 'replace',
      nodes: [
        { id: 'analyze', content: 'Analyze', status: 'completed' },
        { id: 'host', content: 'Host', status: 'pending' },
        { id: 'ui', content: 'UI', status: 'pending' },
        { id: 'test', content: 'Test', status: 'pending' },
      ],
      edges: [
        { from: 'analyze', to: 'host' },
        { from: 'analyze', to: 'ui' },
        { from: 'host', to: 'test' },
        { from: 'ui', to: 'test' },
      ],
    }])

    expect(graph.revision).toBe(1)
    expect(graph.ready).toEqual(['host', 'ui'])
    expect(graph.blocked).toEqual([{ id: 'test', waitingOn: ['host', 'ui'] }])
  })

  it('rejects cycles atomically', () => {
    const graph = applyTodoGraphOperations(empty, [{
      op: 'replace',
      nodes: [
        { id: 'a', content: 'A', status: 'pending' },
        { id: 'b', content: 'B', status: 'pending' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    }])

    expect(() => applyTodoGraphOperations(graph, [{ op: 'add_edge', from: 'b', to: 'a' }])).toThrow(/ECYCLE/)
    expect(graph.edges).toEqual([{ from: 'a', to: 'b' }])
  })

  it('rejects starting blocked work and permits parallel active nodes', () => {
    const graph = applyTodoGraphOperations(empty, [{
      op: 'replace',
      nodes: [
        { id: 'root', content: 'Root', status: 'pending' },
        { id: 'blocked', content: 'Blocked', status: 'pending' },
        { id: 'parallel', content: 'Parallel', status: 'pending' },
      ],
      edges: [{ from: 'root', to: 'blocked' }],
    }])

    expect(() => applyTodoGraphOperations(graph, [{ op: 'update_node', id: 'blocked', status: 'in_progress' }])).toThrow(/EBLOCKED/)
    const active = applyTodoGraphOperations(graph, [
      { op: 'update_node', id: 'root', status: 'in_progress' },
      { op: 'update_node', id: 'parallel', status: 'in_progress' },
    ])
    expect(active.summary.active).toBe(2)
  })

  it('does not treat a cancelled dependency as completed', () => {
    const graph = applyTodoGraphOperations(empty, [{
      op: 'replace',
      nodes: [
        { id: 'a', content: 'A', status: 'cancelled' },
        { id: 'b', content: 'B', status: 'pending' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    }])
    expect(graph.blocked).toEqual([{ id: 'b', waitingOn: ['a'] }])
  })
})
