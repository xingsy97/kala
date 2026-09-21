import { describe, expect, it } from 'vitest'

import type { TimelineEntry } from '../../session.js'
import { parseTasksFromInput, tasksFromMessages, tasksFromTimeline } from './tasks-from-timeline.js'

describe('tasksFromTimeline', () => {
  it('derives a legacy Task List from historical successful todowrite calls', () => {
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-07T00:00:00Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
        effects: [
          {
            kind: 'call_tool',
            callId: 'todo-1',
            name: 'todowrite',
            input: {
              todos: [
                { content: 'Review design', status: 'completed' },
                { content: 'Run tests', status: 'in_progress', priority: 'high' },
              ],
            },
          },
        ],
      },
      {
        seq: 2,
        ts: '2026-07-07T00:00:01Z',
        event: { kind: 'tool_result', callId: 'todo-1', ok: true, content: 'todos updated: 2 items' },
        effects: [],
      },
    ]

    expect(tasksFromTimeline(timeline)).toEqual([
      { content: 'Review design', status: 'completed' },
      { content: 'Run tests', status: 'in_progress', priority: 'high' },
    ])
  })

  it('ignores failed historical todowrite results and malformed entries', () => {
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-07T00:00:00Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
        effects: [
          { kind: 'call_tool', callId: 'todo-1', name: 'todowrite', input: { todos: [{ content: 'Keep', status: 'pending' }] } },
        ],
      },
      { seq: 2, ts: '2026-07-07T00:00:01Z', event: { kind: 'tool_result', callId: 'todo-1', ok: true, content: 'ok' }, effects: [] },
      {
        seq: 3,
        ts: '2026-07-07T00:00:02Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [] } },
        effects: [
          { kind: 'call_tool', callId: 'todo-2', name: 'todowrite', input: { todos: [{ content: 'Bad', status: 'weird' }] } },
        ],
      },
      { seq: 4, ts: '2026-07-07T00:00:03Z', event: { kind: 'tool_result', callId: 'todo-2', ok: false, content: 'EINVAL' }, effects: [] },
    ]

    expect(tasksFromTimeline(timeline)).toEqual([{ content: 'Keep', status: 'pending' }])
    expect(parseTasksFromInput({ todos: [{ content: '', status: 'pending' }, { content: 'Ok', status: 'completed' }] })).toEqual([
      { content: 'Ok', status: 'completed' },
    ])
  })

  it('derives Copilot todo state from projected tool messages', () => {
    expect(tasksFromMessages([
      {
        role: 'assistant',
        content: [{
          type: 'tool_call',
          callId: 'copilot-todo-1',
          name: 'todowrite',
          input: {
            todos: [
              { content: 'Inspect runtime', status: 'completed' },
              { content: 'Deploy fix', status: 'in_progress', priority: 'high' },
            ],
          },
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool_result',
          callId: 'copilot-todo-1',
          ok: true,
          content: 'todos updated',
        }],
      },
    ])).toEqual([
      { content: 'Inspect runtime', status: 'completed' },
      { content: 'Deploy fix', status: 'in_progress', priority: 'high' },
    ])
  })
})
