import { describe, expect, it } from 'vitest'

import { backgroundTerminalTasks } from './background-terminal.js'
import type { TimelineEntry } from './session.js'

describe('backgroundTerminalTasks', () => {
  it('derives background bash tasks and captured output from timeline events', () => {
    const timeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-06T00:00:00.000Z',
        event: {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'start-1',
                name: 'bash',
                input: { command: 'sleep 1; echo done', run_in_background: true },
              },
            ],
          },
        },
        effects: [],
      },
      {
        seq: 2,
        ts: '2026-07-06T00:00:01.000Z',
        event: {
          kind: 'tool_result',
          callId: 'start-1',
          ok: true,
          content: JSON.stringify({ taskId: 'task-1', note: 'started' }),
        },
        effects: [],
      },
      {
        seq: 3,
        ts: '2026-07-06T00:00:02.000Z',
        event: {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                callId: 'out-1',
                name: 'bash_output',
                input: { task_id: 'task-1' },
              },
            ],
          },
        },
        effects: [],
      },
      {
        seq: 4,
        ts: '2026-07-06T00:00:03.000Z',
        event: {
          kind: 'tool_result',
          callId: 'out-1',
          ok: true,
          content: JSON.stringify({ content: 'done\n', nextOffset: 5, done: true }),
        },
        effects: [],
      },
    ]

    expect(backgroundTerminalTasks(timeline)).toEqual([
      {
        taskId: 'task-1',
        callId: 'start-1',
        command: 'sleep 1; echo done',
        status: 'done',
        output: 'done\n',
        nextOffset: 5,
      },
    ])
  })
})
