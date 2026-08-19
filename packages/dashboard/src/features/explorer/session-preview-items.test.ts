import { describe, expect, it } from 'vitest'

import { createInitialState, type Message } from '@agent-kernel/kernel'
import { projectSessionPreviewSummary } from './session-preview-items.js'

function state(status: 'idle' | 'thinking' | 'awaiting_approval' | 'executing_tools' | 'done' | 'error' = 'done') {
  return { ...createInitialState({}), status }
}

describe('projectSessionPreviewSummary', () => {
  it('reduces rich conversation content to a human-readable goal and response', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Please **modernize** the mobile preview.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Implemented the responsive viewer.\n```mermaid\ngraph TD\nA-->B\n```\n```typescript\nconst secret = 1\n```' }, { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'x' } }] },
    ]
    const summary = projectSessionPreviewSummary({ messages, timeline: [], state: state() })

    expect(summary.goal).toBe('Please modernize the mobile preview.')
    expect(summary.response).toBe('Implemented the responsive viewer.')
    expect(summary.stats.omittedContent).toBe(3)
    expect(JSON.stringify(summary)).not.toContain('graph TD')
    expect(JSON.stringify(summary)).not.toContain('const secret')
  })

  it('shows current intention without exposing tool parameters or successful result content', () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: [{
        type: 'tool_call', callId: 'c1', name: 'read_file',
        input: { path: '/private/repository/secret.ts', token: 'do-not-render' },
        intent: 'Confirm why the mobile dialog exceeds the viewport before changing layout constraints.',
      }],
    }]
    const running = {
      ...state('executing_tools'),
      pendingCalls: [{ callId: 'c1', name: 'read_file', input: { path: '/private/repository/secret.ts' }, intent: 'Confirm why the mobile dialog exceeds the viewport before changing layout constraints.', status: 'dispatched' as const }],
    }
    const summary = projectSessionPreviewSummary({ messages, timeline: [], state: running })

    expect(summary.activity).toMatchObject({ label: 'Working', tone: 'active' })
    expect(summary.activity.text).toContain('Confirm why the mobile dialog')
    expect(summary.stats.toolCalls).toBe(1)
    expect(JSON.stringify(summary)).not.toContain('/private/repository')
    expect(JSON.stringify(summary)).not.toContain('do-not-render')
  })

  it('keeps only recent human meaning and aggregates failures instead of rendering raw events', () => {
    const timeline = [
      { seq: 1, ts: '2026-08-09T00:00:00.000Z', event: { kind: 'user_message' as const, text: 'Fix the Session preview readability.' }, effects: [] },
      { seq: 2, ts: '2026-08-09T00:00:01.000Z', event: { kind: 'llm_response' as const, message: { role: 'assistant' as const, content: [{ type: 'tool_call' as const, callId: 'c1', name: 'grep', input: { pattern: 'password', path: '/private' }, intent: 'Locate the preview projection code that expands raw events.' }] } }, effects: [] },
      { seq: 3, ts: '2026-08-09T00:00:02.000Z', event: { kind: 'tool_result' as const, callId: 'c1', ok: false, content: 'sensitive raw failure output' }, effects: [] },
      { seq: 4, ts: '2026-08-09T00:00:03.000Z', event: { kind: 'llm_response' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'The preview now emphasizes the request and outcome.' }] } }, effects: [] },
    ]
    const summary = projectSessionPreviewSummary({ messages: [], timeline, state: state(), queuedMessages: 2 })

    expect(summary.goal).toBe('Fix the Session preview readability.')
    expect(summary.response).toBe('The preview now emphasizes the request and outcome.')
    expect(summary.stats).toMatchObject({ toolCalls: 1, failedTools: 1, queuedMessages: 2 })
    expect(summary.activity.label).toBe('Working')
    expect(JSON.stringify(summary)).not.toContain('sensitive raw failure output')
    expect(JSON.stringify(summary)).not.toContain('/private')
  })

  it('uses an explicit attention state for approvals', () => {
    const awaiting = {
      ...state('awaiting_approval'),
      pendingCalls: [{ callId: 'c1', name: 'shell', input: {}, intent: 'Restart the verified preview service after the safe checkpoint.', status: 'awaiting_approval' as const }],
    }
    const summary = projectSessionPreviewSummary({ messages: [], timeline: [], state: awaiting })
    expect(summary.activity).toEqual({ label: 'Needs attention', text: 'Restart the verified preview service after the safe checkpoint.', tone: 'attention' })
  })
})
