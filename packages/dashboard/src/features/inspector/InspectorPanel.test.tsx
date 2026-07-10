import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState, type AgentState } from '@agent-kernel/kernel'
import type { TimelineEntry } from '../../session.js'
import { InspectorPanel } from './InspectorPanel.js'

type Handler = (payload: unknown) => void

function makeSocket(): {
  socket: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> }
  emit(event: string, payload: unknown): void
} {
  const handlers = new Map<string, Set<Handler>>()
  return {
    socket: {
      on: vi.fn((event: string, cb: Handler) => {
        const set = handlers.get(event) ?? new Set<Handler>()
        set.add(cb)
        handlers.set(event, set)
      }),
      off: vi.fn((event: string, cb: Handler) => {
        handlers.get(event)?.delete(cb)
      }),
      emit: vi.fn(),
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
  }
}

const baseState: AgentState = {
  ...createInitialState({ sessionId: 'sess_20260706_cwd_fix' }),
  status: 'executing_tools',
  usage: {
    inputTokens: 42180,
    outputTokens: 6180,
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
    expect(screen.getByTestId('inspector-view-panel-trace')).toBeTruthy()
    expect(screen.getByTestId('inspector-sidebar-tab-trace').textContent ?? '').toContain('Trace')
    expect(screen.getByTestId('inspector-sidebar-tab-llm').textContent ?? '').toContain('LLM API')
    expect(screen.getByTestId('inspector-sidebar-tab-tools').textContent ?? '').toContain('Tool Call')
    expect(screen.getByTestId('inspector-sidebar-tab-status').textContent ?? '').toContain('Status')
    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-status'))
    expect(screen.getByTestId('inspector-view-panel-status')).toBeTruthy()
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
    expect(screen.getByTestId('inspector-view-panel-trace')).toBeTruthy()
    expect(screen.getByText('No reducer events yet.')).toBeTruthy()
  })

  it('shows compact AgentState groups and opens full JSON on demand', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-status'))
    const topology = screen.getByTestId('status-topology')
    expect(topology.textContent ?? '').toContain('Dashboard')
    expect(topology.textContent ?? '').toContain('Host')
    expect(topology.textContent ?? '').toContain('Executor')
    expect(topology.textContent ?? '').toContain('LLM')
    expect(topology.textContent ?? '').toContain('kernel / model unknown')
    const stateRuntime = screen.getByTestId('state-runtime')
    expect(screen.getByTestId('run-health-panel')).toBeTruthy()
    expect(screen.queryByTestId('watch-expressions')).toBeNull()
    expect(stateRuntime.textContent ?? '').toContain('Core')
    expect(stateRuntime.textContent ?? '').toContain('Workload')
    expect(stateRuntime.textContent ?? '').toContain('Usage')
    expect(stateRuntime.textContent ?? '').toContain('Memory')
    expect(screen.queryByText('Full AgentState JSON')).toBeNull()

    fireEvent.click(screen.getByText('View JSON'))

    expect(screen.getByTestId('agent-state-json-dialog')).toBeTruthy()
    expect(screen.getByText('Full AgentState JSON')).toBeTruthy()
  })

  it('combines event timeline and state flow in Trace rows', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} visibleMessagesCount={3} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(4)
    expect(screen.getByTestId('trace-toolbar')).toBeTruthy()
    expect(screen.getByTestId('replay-panel')).toBeTruthy()
    expect(screen.getByTestId('state-diff-view').textContent ?? '').toContain('status')
    expect(screen.getByTestId('timeline-minimap')).toBeTruthy()
    expect(document.body.textContent ?? '').toContain('idle  -  thinking')
    expect(document.body.textContent ?? '').toContain('thinking  -  awaiting_approval')
    expect(document.body.textContent ?? '').toContain('request_approval')
  })

  it('keeps trace minimap, state diff, and reducer rows on the same active event', () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    render(<InspectorPanel state={baseState} timeline={timeline} visibleMessagesCount={3} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))

    const minimapItems = screen.getAllByTestId('timeline-minimap-item')
    const rows = screen.getAllByTestId('timeline-row')

    expect(minimapItems.at(-1)?.getAttribute('aria-current')).toBe('true')
    expect(rows.at(-1)?.getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('replay-panel').textContent ?? '').toContain('#123')

    fireEvent.click(minimapItems[0]!)

    expect(minimapItems[0]?.getAttribute('aria-current')).toBe('true')
    expect(rows[0]?.getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('replay-panel').textContent ?? '').toContain('#120')
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })

    fireEvent.click(rows[2]!.querySelector('[data-testid="timeline-row-header"]')!)

    expect(minimapItems[2]?.getAttribute('aria-current')).toBe('true')
    expect(rows[2]?.getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('replay-panel').textContent ?? '').toContain('#122')
  })

  it('scrolls the reducer trace list when the replay scrubber changes selection', () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    render(<InspectorPanel state={baseState} timeline={timeline} visibleMessagesCount={3} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    const rows = screen.getAllByTestId('timeline-row')

    fireEvent.change(screen.getByTestId('replay-scrubber'), { target: { value: '1' } })

    expect(rows[1]?.getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('replay-panel').textContent ?? '').toContain('#121')
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
  })

  it('collapses and expands the state diff body', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} visibleMessagesCount={3} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    expect(screen.getByTestId('state-diff-view')).toBeTruthy()

    const toggle = screen.getByTestId('state-diff-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('state-diff-view')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('state-diff-view')).toBeTruthy()
  })

  it('supports trace query, teaching mode, protocol flow, and fork compare loading state', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} parentSessionId="parent-session" parentCursor={121} />)

    fireEvent.change(screen.getByTestId('trace-query-input'), { target: { value: 'kind:tool_result Applied' } })
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(1)
    expect(document.body.textContent ?? '').toContain('tool_result')

    fireEvent.click(screen.getByTestId('teaching-mode-toggle'))
    expect(document.body.textContent ?? '').toContain('state machine moves')

    fireEvent.click(screen.getByTestId('trace-mode-switch-flow'))
    expect(screen.getByTestId('protocol-flow-view')).toBeTruthy()
    expect(screen.getAllByTestId('protocol-flow-row')).toHaveLength(1)
    expect(screen.getByTestId('protocol-flow-view').textContent ?? '').toContain('Input Event')
    expect(screen.getByTestId('protocol-flow-view').textContent ?? '').toContain('State Machine')
    expect(screen.getByTestId('protocol-flow-view').textContent ?? '').toContain('Output Actions')

    fireEvent.click(screen.getByTestId('trace-mode-switch-compare'))
    expect(document.body.textContent ?? '').toContain('Loading parent session history')
  })

  it('does not keep fork compare loading forever when parent history is unavailable', () => {
    const harness = makeSocket()
    render(<InspectorPanel state={baseState} timeline={timeline} parentSessionId="deleted-parent" parentCursor={121} socket={harness.socket as never} />)

    fireEvent.click(screen.getByTestId('trace-mode-switch-compare'))
    expect(harness.socket.emit).toHaveBeenCalledWith('client:load_history', { sessionId: 'deleted-parent' })

    act(() => {
      harness.emit('server:history', { sessionId: 'deleted-parent', entries: [] })
    })

    expect(document.body.textContent ?? '').toContain('Parent session history is unavailable')
    expect(document.body.textContent ?? '').not.toContain('Loading parent session history')
  })

  it('shows LLM calls with message assembler and API call tabs', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-llm'))
    expect(screen.getAllByTestId('llm-call-row')).toHaveLength(2)
    expect(document.body.textContent ?? '').toContain('anthropic / claude-sonnet-4-6')
    expect(document.body.textContent ?? '').toContain('provider trace captured')

    fireEvent.click(screen.getAllByTestId('llm-call-row')[0]!)
    const detail = screen.getByTestId('llm-detail')
    expect(detail.textContent ?? '').toContain('Message Assembler')
    expect(detail.textContent ?? '').toContain('API Call')
    expect(screen.getByTestId('message-assembler-view')).toBeTruthy()
    expect(screen.getByTestId('llm-assembly-view').textContent ?? '').toContain('System Prompt')
    expect(screen.getByTestId('llm-assembly-view').textContent ?? '').toContain('Adapter Transform')
    expect(screen.getByTestId('context-proportion-bar').textContent ?? '').toContain('User')
    expect(screen.getByTestId('context-proportion-bar').textContent ?? '').toContain('Tool registry')
    expect(screen.getByTestId('llm-context-view')).toBeTruthy()

    fireEvent.click(screen.getByTestId('llm-detail-view-switch-api'))
    const apiCall = screen.getByTestId('api-call-view').textContent ?? ''
    expect(screen.getByTestId('api-summary-strip')).toBeTruthy()
    expect(apiCall).toContain('Captured API Request')
    expect(apiCall).toContain('Captured API Response')
    expect(apiCall).toContain('Parsed Kernel Response')
    expect(apiCall).toContain('https://<redacted>/v1/messages')
    expect(apiCall).toContain('test-redacted-api-key')
    expect(apiCall).not.toContain('api.anthropic.com')
    expect(apiCall).not.toContain('API Request Body')
    expect(apiCall).not.toContain('Kernel call_llm Effect')
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

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-llm'))
    expect(document.body.textContent ?? '').toContain('openai / gpt-5.5')
    fireEvent.click(screen.getByTestId('llm-call-row'))

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

  it('does not round non-empty system context down to 0 percent', () => {
    const largeTools = Array.from({ length: 20 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'large tool description '.repeat(80),
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      requiresApproval: false,
    }))
    const tinySystemTimeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-06T06:30:00Z',
        event: { kind: 'user_message', text: 'hi' },
        effects: [
          {
            kind: 'call_llm',
            messages: [
              { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
              { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            ],
            tools: largeTools,
          },
        ],
      },
      {
        seq: 2,
        ts: '2026-07-06T06:30:01Z',
        event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
        effects: [],
      },
    ]
    render(<InspectorPanel state={baseState} timeline={tinySystemTimeline} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-llm'))
    fireEvent.click(screen.getByTestId('llm-call-row'))

    const composition = screen.getByTestId('context-proportion-bar').textContent ?? ''
    expect(composition).toContain('System')
    expect(composition).toContain('<1%')
    expect(composition).not.toContain('System0%')
  })

  it('links context composition sections to kernel messages and tool registry rows', () => {
    const messagesTimeline: TimelineEntry[] = [
      {
        seq: 10,
        ts: '2026-07-06T06:20:00Z',
        event: { kind: 'tool_result', callId: 'c1', ok: true, content: 'loaded skill' },
        effects: [
          {
            kind: 'call_llm',
            messages: [
              { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
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
        event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] } },
        effects: [],
      },
    ]
    render(<InspectorPanel state={baseState} timeline={messagesTimeline} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-llm'))
    fireEvent.click(screen.getByTestId('llm-call-row'))

    fireEvent.click(screen.getByTestId('context-proportion-segment-user'))
    const messageRows = screen.getAllByTestId('kernel-message-row')
    expect(messageRows.map((row) => row.getAttribute('data-highlighted'))).toEqual(['false', 'true', 'false', 'false'])

    fireEvent.click(screen.getByTestId('context-proportion-segment-tools'))
    expect(screen.getByTestId('tool-registry-context-view')).toBeTruthy()
    expect(screen.getByTestId('llm-tool-row').getAttribute('data-highlighted')).toBe('true')
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

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-llm'))
    expect(document.body.textContent ?? '').toContain('anthropic / claude-haiku-4-6')

    fireEvent.click(screen.getByTestId('llm-call-row'))
    expect(screen.getByTestId('llm-detail').textContent ?? '').toContain('claude-haiku-4-6')
  })

  it('groups tool lifecycle events by call id', () => {
    render(<InspectorPanel state={baseState} timeline={timeline} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-tools'))
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

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-status'))
    fireEvent.click(screen.getByTestId('runtime-view-switch-tools'))
    expect(screen.getByTestId('tool-registry')).toBeTruthy()
    expect(screen.getAllByText('edit').length).toBeGreaterThan(0)
    expect(screen.getByText('approval required')).toBeTruthy()
    expect(document.body.textContent ?? '').toContain('Input schema  -  edit')
  })

  it('summarizes sub-agent parent and child relations in status state', () => {
    const agentTimeline: TimelineEntry[] = [
      {
        seq: 1,
        ts: '2026-07-06T06:00:00Z',
        event: {
          kind: 'llm_response',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_call', callId: 'agent-1', name: 'agent', input: { prompt: 'inspect' } }],
          },
        },
        effects: [{ kind: 'call_tool', callId: 'agent-1', name: 'agent', input: { prompt: 'inspect' } }],
      },
      {
        seq: 2,
        ts: '2026-07-06T06:00:01Z',
        event: { kind: 'tool_result', callId: 'agent-1', ok: true, content: '<sub_agent>done</sub_agent>' },
        effects: [],
      },
    ]

    render(<InspectorPanel state={baseState} timeline={agentTimeline} parentSessionId="parent-1" parentCursor={7} />)

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-status'))
    const panel = screen.getByTestId('sub-agent-relation-panel')
    expect(panel.textContent ?? '').toContain('parent-1 @7')
    expect(panel.textContent ?? '').toContain('Children')
    expect(panel.textContent ?? '').toContain('Completed')
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

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-status'))
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

  it('shows recorded compact request metadata for compact events', () => {
    const compactMessages = [
      { role: 'system' as const, content: [{ type: 'text' as const, text: 'sys' }] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello?' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Hello!' }] },
    ]
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
            event: {
              kind: 'compact_replaced',
              preserveFrom: 3,
              request: {
                model: 'gpt-test',
                systemPrompt: 'compact prompt',
                messages: compactMessages,
                tools: [],
              },
              summary: 'Hello!',
              replacedCount: 3,
              tokensBefore: 1008,
              tokensAfter: 2,
            },
            effects: [],
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByTestId('inspector-sidebar-tab-trace'))
    fireEvent.click(screen.getAllByTestId('timeline-row-header')[2]!)
    const details = screen.getByTestId('timeline-row-details')
    expect(details.textContent ?? '').toContain('Compaction Request')
    expect(details.textContent ?? '').toContain('compact prompt')
    expect(details.textContent ?? '').not.toContain('reconstructed_from_timeline')
  })
})
