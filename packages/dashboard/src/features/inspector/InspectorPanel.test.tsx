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
    expect(screen.getByTestId('inspector-sidebar-tabs')).toBeTruthy()
    expect(screen.getByTestId('debugger-sidebar-tabpanel')).toBeTruthy()
    expect(screen.getByText('Runtime Objects')).toBeTruthy()
    expect(screen.queryByText('Selected Detail')).toBeNull()
    expect(screen.getByText('No AgentState loaded.')).toBeTruthy()
    const overview = screen.getByLabelText('debugger overview')
    expect(overview.textContent ?? '').toContain('Status')
    expect(overview.textContent ?? '').toContain('Events')
    expect(overview.textContent ?? '').toContain('Context')
    expect(overview.textContent ?? '').toContain('Pending')
    expect(overview.textContent ?? '').not.toContain('Messages')
    expect(overview.textContent ?? '').not.toContain('Tools')
    expect(overview.textContent ?? '').not.toContain('Memory')
    expect(overview.textContent ?? '').not.toContain('Approval')

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    expect(screen.getByTestId('trace-sidebar-tabpanel')).toBeTruthy()
    expect(screen.getByText('No reducer events yet.')).toBeTruthy()
  })

  it('shows compact AgentState groups and opens full JSON on demand', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} />)

    const stateRuntime = screen.getByTestId('state-runtime')
    expect(stateRuntime.textContent ?? '').toContain('Core')
    expect(stateRuntime.textContent ?? '').toContain('Workload')
    expect(stateRuntime.textContent ?? '').toContain('Usage')
    expect(stateRuntime.textContent ?? '').toContain('Memory')
    expect(screen.queryByText('Full AgentState JSON')).toBeNull()

    fireEvent.click(screen.getByText('View JSON'))

    expect(screen.getByTestId('agent-state-json-dialog')).toBeTruthy()
    expect(screen.getByText('Full AgentState JSON')).toBeTruthy()
  })

  it('combines event timeline and state flow in Reducer Trace rows', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} visibleMessagesCount={3} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    expect(screen.getByTestId('trace-view-switch')).toBeTruthy()
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(4)
    expect(document.body.textContent ?? '').toContain('idle  -  thinking')
    expect(document.body.textContent ?? '').toContain('thinking  -  awaiting_approval')
    expect(document.body.textContent ?? '').toContain('request_approval')
  })

  it('shows LLM calls with message assembly, provider payload, and response tabs', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    fireEvent.click(screen.getByTestId('trace-view-switch-llm'))
    expect(screen.getAllByTestId('llm-call-row')).toHaveLength(2)
    expect(document.body.textContent ?? '').toContain('anthropic / claude-sonnet-4-6')
    expect(document.body.textContent ?? '').toContain('provider trace captured')

    fireEvent.click(screen.getAllByTestId('llm-call-row')[0]!)
    const detail = screen.getByTestId('llm-detail')
    expect(detail.textContent ?? '').toContain('LLM Message Assembly')
    expect(screen.getByTestId('llm-assembly-view').textContent ?? '').toContain('System Prompt')
    expect(screen.getByTestId('llm-assembly-view').textContent ?? '').toContain('Adapter Transform')
    expect(screen.getByTestId('context-proportion-bar').textContent ?? '').toContain('messages')
    expect(screen.getByTestId('context-proportion-bar').textContent ?? '').toContain('tools')

    fireEvent.click(screen.getByTestId('llm-detail-view-switch-payload'))
    expect(screen.getByTestId('provider-payload-view').textContent ?? '').toContain('Provider Request')
    expect(screen.getByTestId('provider-payload-view').textContent ?? '').toContain('Kernel Request')
    expect(screen.getByTestId('provider-payload-view').textContent ?? '').toContain('test-redacted-api-key')

    fireEvent.click(screen.getByTestId('llm-detail-view-switch-response'))
    expect(screen.getByTestId('llm-response-view').textContent ?? '').toContain('Provider Response')
    expect(screen.getByTestId('llm-response-view').textContent ?? '').toContain('Parsed Kernel Response')
  })

  it('shows kernel messages for a selected LLM call', () => {
    const messagesTimeline: TimelineEntry[] = [
      {
        seq: 10,
        ts: '2026-07-06T06:20:00Z',
        event: { kind: 'tool_result', callId: 'c1', ok: true, content: 'loaded skill' },
        effects: [
          {
            kind: 'call_llm',
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'Use code review skill.' }] },
              {
                role: 'assistant',
                content: [{ type: 'tool_call', callId: 'c1', name: 'skill', input: { name: 'code-review' } }],
              },
              { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', ok: true, content: 'loaded skill' }] },
            ],
            tools: [
              {
                name: 'skill',
                description: 'Load a skill.',
                inputSchema: { type: 'object' },
                requiresApproval: false,
              },
            ],
          },
        ],
      },
      {
        seq: 11,
        ts: '2026-07-06T06:20:01Z',
        event: {
          kind: 'llm_response',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] },
        },
        effects: [],
        llmTrace: {
          provider: 'openai',
          model: 'gpt-5.5',
          request: {
            url: 'https://api.openai.com/v1/chat/completions',
            headers: { authorization: 'Bearer redacted' },
            body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'Use code review skill.' }], tools: [] },
          },
          response: { status: 200, body: { choices: [] } },
        },
      },
    ]
    render(<InspectorPanel state={baseState} timeline={messagesTimeline} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    fireEvent.click(screen.getByTestId('trace-view-switch-llm'))
    expect(document.body.textContent ?? '').toContain('openai / gpt-5.5')
    fireEvent.click(screen.getByTestId('llm-call-row'))
    fireEvent.click(screen.getByTestId('llm-detail-view-switch-context'))

    expect(screen.getByTestId('llm-context-view')).toBeTruthy()
    expect(screen.getByTestId('kernel-messages-view')).toBeTruthy()
    expect(screen.getAllByTestId('kernel-message-row')).toHaveLength(3)
    expect(screen.getByTestId('kernel-messages-view').textContent ?? '').toContain('Use code review skill.')
    expect(screen.getByTestId('kernel-messages-view').textContent ?? '').toContain('tool_call skill')

    fireEvent.click(screen.getByTestId('llm-context-view-switch-tools'))
    expect(screen.getByTestId('tool-registry-context-view')).toBeTruthy()
    expect(screen.getByTestId('tool-registry-context-view').textContent ?? '').toContain('skill')
    expect(screen.getByTestId('tool-registry-context-view').textContent ?? '').toContain('Load a skill.')
  })

  it('falls back to provider request body when trace model is missing', () => {
    const legacyTraceTimeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-06T06:10:00Z',
        event: { kind: 'user_message', text: 'Use the small model.' },
        effects: [{ kind: 'call_llm', messages: [], tools: [] }],
      },
      {
        seq: 2,
        ts: '2026-07-06T06:10:01Z',
        event: {
          kind: 'llm_response',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        },
        effects: [],
        llmTrace: {
          provider: 'unknown',
          request: {
            url: 'https://api.anthropic.com/v1/messages',
            headers: { 'content-type': 'application/json' },
            body: { model: 'claude-haiku-4-6', messages: [] },
          },
          response: { status: 200, body: { content: [{ type: 'text', text: 'Done.' }] } },
        } as TimelineEntry['llmTrace'],
      },
    ]
    render(<InspectorPanel state={baseState} timeline={legacyTraceTimeline} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    fireEvent.click(screen.getByTestId('trace-view-switch-llm'))
    expect(document.body.textContent ?? '').toContain('anthropic / claude-haiku-4-6')

    fireEvent.click(screen.getByTestId('llm-call-row'))
    expect(screen.getByTestId('llm-detail').textContent ?? '').toContain('claude-haiku-4-6')
  })

  it('groups tool lifecycle events by call id', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
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

  it('marks the skill loader tool in the tools object inspector', () => {
    render(
      <InspectorPanel
        state={baseState}
        timeline={timeline}
        config={{
          tools: [
            {
              name: 'skill',
              description: 'Load one reusable agent skill by name.',
              requiresApproval: false,
              inputSchema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
            {
              name: 'edit',
              description: 'Replace exact text in a workspace file.',
              requiresApproval: true,
              inputSchema: { type: 'object' },
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByTestId('runtime-view-switch-tools'))

    expect(screen.getByTestId('tool-registry').textContent ?? '').toContain('skill')
    expect(screen.getByTestId('tool-registry').textContent ?? '').toContain('auto')
    expect(screen.getByText('Skill loader')).toBeTruthy()
    expect(screen.getByText('auto allowed')).toBeTruthy()
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

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
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

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    fireEvent.click(screen.getAllByTestId('timeline-row-header')[2]!)
    const details = screen.getByTestId('timeline-row-details')
    expect(details.textContent ?? '').toContain('Compaction Request')
    expect(details.textContent ?? '').toContain('reconstructed_from_timeline')
  })
})
