import { describe, expect, it } from 'vitest'

import type { TimelineEntry } from '../../session.js'
import { taskGraphFromTimeline } from './task-graph-from-timeline.js'

describe('taskGraphFromTimeline', () => {
  it('uses the latest successful valid todo_graph result', () => {
    const snapshot = {
      version: 1 as const, revision: 1,
      nodes: [{ id: 'a', content: 'A', status: 'pending' as const }], edges: [],
      summary: { total: 1, completed: 0, active: 0, ready: 1, blocked: 0, cancelled: 0 },
      ready: ['a'], blocked: [], changed: ['a'],
    }
    const timeline: TimelineEntry[] = [
      { seq: 1, ts: '2026-01-01T00:00:00Z', event: { kind: 'user_message', text: 'plan' }, effects: [{ kind: 'call_tool', callId: 'g1', name: 'todo_graph', input: { operations: [] } }] },
      { seq: 2, ts: '2026-01-01T00:00:01Z', event: { kind: 'tool_result', callId: 'g1', ok: true, content: JSON.stringify(snapshot) }, effects: [] },
      { seq: 3, ts: '2026-01-01T00:00:02Z', event: { kind: 'tool_result', callId: 'bad', ok: true, content: '{}' }, effects: [] },
    ]
    expect(taskGraphFromTimeline(timeline)?.ready).toEqual(['a'])
  })
})
