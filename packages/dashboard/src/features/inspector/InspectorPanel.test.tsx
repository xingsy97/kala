import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState, type AgentState } from '@agent-kernel/kernel'
import type { TimelineEntry } from '../../session.js'
import { InspectorPanel } from './InspectorPanel.js'

const baseState: AgentState = {
  ...createInitialState({ sessionId: 'sess_20260706_cwd_fix' }),
  status: 'executing_tools',
  usage: {
    inputTokens: 42180,
    outputTokens: 6180,
    costUsd: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 32000,
  },
  cursor: 128,
  cwd: '/workspace/project',
  approvalMode: 'ask',
}

const timeline: TimelineEntry[] = [
  {
    seq: 120,
    ts: '2026-07-06T06:00:00Z',
    event: { kind: 'user_message', text: ' -  executor  -  cwd  - ' },
    effects: [{ kind: 'call_llm', messages: [], tools: [] }],
  },
  {
    seq: 121,
    ts: '2026-07-06T06:00:01Z',
    event: {
      kind: 'llm_response',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: 'toolu_01J4Z7K9V2N8Q5M3B1C6D0E4',
            name: 'edit',
            input: {
              path: 'packages/executor/src/sandbox.ts',
              oldText: 'const base = canonicalRoots[0] ?? process.cwd()',
              newText: 'const base = opts?.cwd ?? canonicalRoots[0] ?? process.cwd()',
            },
          },
        ],
      },
      usage: { inputTokens: 42180, outputTokens: 614, cacheReadTokens: 32000 },
    },
    effects: [
      {
        kind: 'request_approval',
        callId: 'toolu_01J4Z7K9V2N8Q5M3B1C6D0E4',
        name: 'edit',
        input: { path: 'packages/executor/src/sandbox.ts' },
      },
    ],
    llmTrace: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      request: {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'test-redacted-api-key',
        },
        body: {
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          stream: true,
          messages: [{ role: 'user', content: [{ type: 'text', text: ' -  executor  -  cwd  - ' }] }],
        },
      },
      response: {
        status: 200,
        streamEventTypes: ['message_start', 'content_block_start', 'content_block_delta', 'message_delta', 'message_stop'],
        body: { role: 'assistant', content: [{ type: 'tool_use', name: 'edit' }] },
      },
    },
  },
  {
    seq: 122,
    ts: '2026-07-06T06:00:02Z',
    event: { kind: 'user_approve', callId: 'toolu_01J4Z7K9V2N8Q5M3B1C6D0E4' },
    effects: [
      {
        kind: 'call_tool',
        callId: 'toolu_01J4Z7K9V2N8Q5M3B1C6D0E4',
        name: 'edit',
        input: { path: 'packages/executor/src/sandbox.ts' },
      },
    ],
  },
  {
    seq: 123,
    ts: '2026-07-06T06:00:03Z',
    event: {
      kind: 'tool_result',
      callId: 'toolu_01J4Z7K9V2N8Q5M3B1C6D0E4',
      ok: true,
      content: 'Applied patch to packages/executor/src/sandbox.ts',
    },
    effects: [{ kind: 'call_llm', messages: [], tools: [] }],
  },
]

describe('InspectorPanel', () => {
  it('renders the debugger header, overview, and empty states', () => {
    render(<InspectorPanel state={null} timeline={[]} />)

    expect(screen.getByText('Agent Kernel Debugger')).toBeTruthy()
    expect(screen.getByText('Trace View')).toBeTruthy()
    expect(screen.getByText('Runtime Objects')).toBeTruthy()
    expect(screen.queryByText('Selected Detail')).toBeNull()
    expect(screen.getByText('No reducer events yet.')).toBeTruthy()
    expect(screen.getByText('No AgentState loaded.')).toBeTruthy()
  })

  it('combines event timeline and state flow in Reducer Trace rows', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} visibleMessagesCount={3} />)

    expect(screen.getByTestId('trace-view-switch')).toBeTruthy()
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(4)
    expect(document.body.textContent ?? '').toContain('idle  -  thinking')
    expect(document.body.textContent ?? '').toContain('thinking  -  awaiting_approval')
    expect(document.body.textContent ?? '').toContain('request_approval')
  })

  it('shows LLM calls with provider trace and selected request/response JSON', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} />)

    fireEvent.click(screen.getByTestId('trace-view-switch-llm'))
    expect(screen.getAllByTestId('llm-call-row')).toHaveLength(2)
    expect(document.body.textContent ?? '').toContain('anthropic / claude-sonnet-4-6')
    expect(document.body.textContent ?? '').toContain('provider trace captured')

    fireEvent.click(screen.getAllByTestId('llm-call-row')[0]!)
    const detail = screen.getByTestId('llm-detail')
    expect(detail.textContent ?? '').toContain('Kernel Request')
    expect(detail.textContent ?? '').toContain('Provider Request')
    expect(detail.textContent ?? '').toContain('Provider Response')
    expect(detail.textContent ?? '').toContain('test-redacted-api-key')
  })

  it('groups tool lifecycle events by call id', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} />)

    fireEvent.click(screen.getByTestId('trace-view-switch-tools'))
    expect(screen.getAllByTestId('tool-call-row')).toHaveLength(1)
    expect(document.body.textContent ?? '').toContain('requested #121  -  approved #122  -  result #123')
    expect(document.body.textContent ?? '').toContain('packages/executor/src/sandbox.ts')

    fireEvent.click(screen.getByTestId('tool-call-row'))
    const detail = screen.getByTestId('tool-detail')
    expect(detail.textContent ?? '').toContain('Tool Input')
    expect(detail.textContent ?? '').toContain('Tool Result Event')
  })

  it('shows the tools object inspector with selected schema', () => {
    render(
      <InspectorPanel
        state={baseState}
        timeline={timeline}
        config={{
          tools: [
            {
              name: 'edit',
              description: 'Replace exact text in a workspace file.',
              requiresApproval: true,
              inputSchema: {
                type: 'object',
                required: ['path', 'oldText', 'newText'],
                properties: {
                  path: { type: 'string' },
                  oldText: { type: 'string' },
                  newText: { type: 'string' },
                },
              },
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByTestId('runtime-view-switch-tools'))
    expect(screen.getByTestId('tool-registry')).toBeTruthy()
    expect(screen.getAllByText('edit').length).toBeGreaterThan(0)
    expect(screen.getByText('approval required')).toBeTruthy()
    expect(document.body.textContent ?? '').toContain('Input schema  -  edit')
  })

  it('invokes jump-to-message and confirms fork from reducer rows', () => {
    const onJumpToMessage = vi.fn()
    const onFork = vi.fn()
    render(
      <InspectorPanel
        state={{
          ...baseState,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'hey' }] },
          ],
        }}
        timeline={timeline.slice(0, 2)}
        visibleMessagesCount={2}
        onJumpToMessage={onJumpToMessage}
        onFork={onFork}
      />,
    )

    fireEvent.click(screen.getByTitle(/scroll chat to message #1/))
    expect(onJumpToMessage).toHaveBeenCalledWith(1)

    fireEvent.click(screen.getByLabelText(/fork at cursor 120/))
    fireEvent.click(screen.getByTestId('confirm-fork-button'))
    expect(onFork).toHaveBeenCalledWith(120)
  })

  it('reconstructs compact input for legacy compact events without request metadata', () => {
    render(
      <InspectorPanel
        state={baseState}
        timeline={[
          { seq: 1, ts: '2026-07-04T00:00:00Z', event: { kind: 'user_message', text: 'Hello?' }, effects: [] },
          {
            seq: 2,
            ts: '2026-07-04T00:00:01Z',
            event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] } },
            effects: [],
          },
          {
            seq: 3,
            ts: '2026-07-04T00:00:02Z',
            event: { kind: 'compact_replaced', summary: 'Hello!', replacedCount: 3, tokensBefore: 1008, tokensAfter: 2 },
            effects: [],
          },
        ]}
      />,
    )

    fireEvent.click(screen.getAllByTestId('timeline-row-header')[2]!)
    const details = screen.getByTestId('timeline-row-details')
    expect(details.textContent ?? '').toContain('Compaction Request')
    expect(details.textContent ?? '').toContain('reconstructed_from_timeline')
  })
})
