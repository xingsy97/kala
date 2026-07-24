import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Message, ToolCallContent, ToolResultContent } from '@agent-kernel/kernel'

import { SubAgentCard } from './SubAgentCard.js'
import { ChatPanel } from './ChatPanel.js'
import type { ToolCallGroup } from './grouping.js'
import type { DashboardSocket } from '../../session.js'

function makeCall(callId: string, input: Record<string, unknown> = {}): ToolCallContent {
  return {
    type: 'tool_call',
    callId,
    name: 'agent',
    input,
  }
}

function makeGroup(
  calls: ToolCallContent[],
  results: Array<[string, ToolResultContent]> = [],
): ToolCallGroup {
  return {
    kind: 'tool_call_group',
    toolName: 'agent',
    mixed: false,
    calls,
    results: new Map(results),
    firstCallId: calls[0]!.callId,
  }
}

describe('SubAgentCard', () => {
  it('renders the pending state before any envelope arrives', () => {
    const group = makeGroup([makeCall('c1', { prompt: 'find the bug', agent_type: 'Explore' })])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Pending')
    expect(screen.getByText('Explore')).toBeTruthy()
    expect(screen.getAllByText('find the bug').length).toBeGreaterThan(0)
    // Beam is only drawn when a child session is actively running.
    expect(screen.queryByTestId('border-beam')).toBeNull()
  })

  it('draws the border beam only while the sub-agent is running', async () => {
    const call = makeCall('c1', { prompt: 'search', agent_type: 'Explore' })
    const group = makeGroup([call])
    const socket = makeControlledSocket()
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket.socket}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    // Idle before any lifecycle event fires — no beam.
    expect(screen.queryByTestId('border-beam')).toBeNull()

    act(() => {
      socket.emitStarted({
        parentSessionId: 'parent-1',
        parentCallId: 'c1',
        childSessionId: 'child-1',
        agentType: 'Explore',
        prompt: 'search',
        startedAt: new Date().toISOString(),
      })
    })
    await waitFor(() => expect(screen.getByTestId('border-beam')).toBeTruthy())

    act(() => {
      socket.emitFinished({
        parentSessionId: 'parent-1',
        parentCallId: 'c1',
        childSessionId: 'child-1',
        status: 'completed',
        turns: 1,
        durationMs: 500,
        finishedAt: new Date().toISOString(),
      })
    })
    await waitFor(() => expect(screen.queryByTestId('border-beam')).toBeNull())
  })

  it('renders the completed state from a parsed envelope', () => {
    const call = makeCall('c1', { prompt: 'summarize', agent_type: 'Explore' })
    const envelope = [
      '<sub_agent',
      '  session_id="child-9"',
      '  agent_type="Explore"',
      '  status="completed"',
      '  turns="4"',
      '  duration_ms="12000"',
      '>',
      '<result>',
      'done',
      '</result>',
      '</sub_agent>',
    ].join('\n')
    const result: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: envelope,
      isError: false,
    }
    const group = makeGroup([call], [['c1', result]])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Completed')
    expect(badge.textContent).toContain('4 turns')
    const row = screen.getByTestId('sub-agent-row-c1')
    expect(row.getAttribute('data-sub-agent-status')).toBe('completed')
  })

  it('renders the failed state and shows the error body', () => {
    const call = makeCall('c1', { prompt: 'noop' })
    const envelope = [
      '<sub_agent',
      '  session_id="depth-exceeded"',
      '  status="failed"',
      '  turns="0"',
      '  duration_ms="42"',
      '>',
      '<error>',
      'agent depth exceeded',
      '</error>',
      '</sub_agent>',
    ].join('\n')
    const result: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: envelope,
      isError: true,
    }
    const group = makeGroup([call], [['c1', result]])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Failed')
    expect(screen.getByText(/agent depth exceeded/)).toBeTruthy()
    const row = screen.getByTestId('sub-agent-row-c1')
    expect(row.getAttribute('data-sub-agent-status')).toBe('failed')
  })

  it('renders the cancelled state from a parsed envelope', () => {
    const call = makeCall('c1', { prompt: 'noop' })
    const envelope = [
      '<sub_agent',
      '  session_id="child-cancelled"',
      '  status="cancelled"',
      '  turns="2"',
      '  duration_ms="300"',
      '>',
      '<error>',
      'interrupted by user',
      '</error>',
      '</sub_agent>',
    ].join('\n')
    const result: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: envelope,
      isError: true,
    }
    const group = makeGroup([call], [['c1', result]])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Cancelled')
    expect(screen.getByText(/interrupted by user/)).toBeTruthy()
    const row = screen.getByTestId('sub-agent-row-c1')
    expect(row.getAttribute('data-sub-agent-status')).toBe('cancelled')
  })

  it('emits client:interrupt_sub_agent for a running child', async () => {
    const call = makeCall('c1', { prompt: 'search', agent_type: 'Explore' })
    const group = makeGroup([call])
    const socket = makeControlledSocket()
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket.socket}
        group={group}
        approvalByCallId={new Map()}
      />,
    )

    act(() => {
      socket.emitStarted({
        parentSessionId: 'parent-1',
        parentCallId: 'c1',
        childSessionId: 'child-1',
        agentType: 'Explore',
        prompt: 'search',
        startedAt: new Date().toISOString(),
      })
    })

    await waitFor(() => expect(screen.getByTestId('sub-agent-interrupt-c1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sub-agent-interrupt-c1'))

    expect(socket.emit).toHaveBeenCalledWith('client:interrupt_sub_agent', {
      parentSessionId: 'parent-1',
      parentCallId: 'c1',
      childSessionId: 'child-1',
    })
  })

  it('falls back to pending when the tool_result content is a legacy pre-envelope string', () => {
    const call = makeCall('c1', { prompt: 'noop' })
    const legacy: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: 'plain child response text, no envelope',
      isError: false,
    }
    const group = makeGroup([call], [['c1', legacy]])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const badge = screen.getByTestId('sub-agent-status-badge')
    expect(badge.textContent).toContain('Pending')
  })

  it('renders replayed child messages when subscribe replies immediately', async () => {
    const call = makeCall('c1', { prompt: 'summarize', agent_type: 'Explore' })
    const envelope = [
      '<sub_agent',
      '  session_id="child-9"',
      '  agent_type="Explore"',
      '  status="completed"',
      '  turns="1"',
      '  duration_ms="120"',
      '>',
      '<result>',
      'done',
      '</result>',
      '</sub_agent>',
    ].join('\n')
    const result: ToolResultContent = {
      type: 'tool_result',
      callId: 'c1',
      content: envelope,
      ok: true,
    }
    const group = makeGroup([call], [['c1', result]])
    const socket = makeImmediateReadySocket('child-9', [
      { role: 'user', content: [{ type: 'text', text: 'child prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'child answer visible with $a^2$' }] },
    ])

    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket}
        group={group}
        approvalByCallId={new Map()}
      />,
    )

    fireEvent.click(screen.getByTestId('sub-agent-toggle-c1'))
    await waitFor(() => expect(screen.getByText(/child answer visible/)).toBeTruthy())
    expect(document.querySelector('.katex')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-transcript-frame-c1').getAttribute('data-layout')).toBe('content')
    expect(screen.getByTestId('nested-transcript').getAttribute('data-virtualized')).toBe('false')
  })

  it('recovers a running child session from sub_agent:list after refresh', async () => {
    const call = makeCall('c-live', { prompt: 'summarize', agent_type: 'Explore' })
    const group = makeGroup([call])
    const socket = makeRecoveringSocket({
      parentSessionId: 'parent-1',
      parentCallId: 'c-live',
      childSessionId: 'child-live',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'child prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'child is still working' }] },
      ],
    })

    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={socket}
        group={group}
        approvalByCallId={new Map()}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('sub-agent-row-c-live').getAttribute('data-sub-agent-status')).toBe('running'))
    await waitFor(() => expect(screen.getByText(/child is still working/)).toBeTruthy())
    expect(screen.getByTestId('sub-agent-transcript-frame-c-live').getAttribute('data-layout')).toBe('viewport')
    expect(screen.getByTestId('nested-transcript').getAttribute('data-virtualized')).toBe('true')
  })

  it('surfaces a resolved policy artifact inline on the expanded row', async () => {
    const artifact = {
      schemaVersion: 1,
      parentSessionId: 'parent-1',
      parentCallId: 'c1',
      childSessionId: 'child-9',
      createdAt: new Date().toISOString(),
      policy: {
        role: 'research',
        objective: 'summarize the repo layout',
        allowedTools: ['read', 'grep'],
        maxTurns: 12,
        timeoutMs: 90_000,
        expectedOutput: 'Structured summary with file:line references.',
        reasons: ['role_template_applied', 'policy_allowed_tools_intersected'],
      },
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          path: 'subagent-policies/parent-1/c1.json',
          mediaType: 'application/json',
          body: artifact,
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const call = makeCall('c1', { prompt: 'summarize', agent_type: 'Explore', role: 'research' })
      const group = makeGroup([call])
      render(
        <SubAgentCard
          parentSessionId="parent-1"
          socket={null}
          group={group}
          approvalByCallId={new Map()}
        />,
      )
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/artifacts/content?path=subagent-policies%2Fparent-1%2Fc1.json',
          { cache: 'no-store' },
        ),
      )
      const panel = await screen.findByTestId('sub-agent-policy-c1')
      expect(panel.textContent).toContain('research')
      expect(panel.textContent).toContain('read, grep')
      expect(panel.textContent).toContain('12')
      expect(panel.textContent).toContain('90s')
      expect(panel.textContent).toContain('summarize the repo layout')
      expect(panel.textContent).toContain('role_template_applied')
      expect(panel.textContent).toContain('policy_allowed_tools_intersected')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders nothing when no policy artifact exists', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const call = makeCall('c2', { prompt: 'noop' })
      const group = makeGroup([call])
      render(
        <SubAgentCard
          parentSessionId="parent-1"
          socket={null}
          group={group}
          approvalByCallId={new Map()}
        />,
      )
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(screen.queryByTestId('sub-agent-policy-c2')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders depth and fan-out chips when the policy artifact carries them', async () => {
    const artifact = {
      schemaVersion: 1,
      parentSessionId: 'parent-1',
      parentCallId: 'c3',
      createdAt: new Date().toISOString(),
      policy: {
        role: 'research',
        allowedTools: ['read'],
        maxDepth: 3,
        resolvedDepth: 2,
        maxFanOut: 4,
        concurrentSiblingCount: 1,
        reasons: ['role_template_applied'],
      },
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          path: 'subagent-policies/parent-1/c3.json',
          mediaType: 'application/json',
          body: artifact,
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const call = makeCall('c3', { prompt: 'summarize', agent_type: 'Explore', role: 'research' })
      const group = makeGroup([call])
      render(
        <SubAgentCard
          parentSessionId="parent-1"
          socket={null}
          group={group}
          approvalByCallId={new Map()}
        />,
      )
      const panel = await screen.findByTestId('sub-agent-policy-c3')
      expect(panel.textContent).toContain('depth')
      expect(panel.textContent).toContain('2/3')
      expect(panel.textContent).toContain('fan-out')
      expect(panel.textContent).toContain('1/4')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ChatPanel sub-agent dispatch', () => {
  it('routes the `agent` tool_call group through SubAgentCard when parentSessionId is set', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: 'c1',
            name: 'agent',
            input: { prompt: 'go look at things', agent_type: 'Explore' },
          },
        ],
      },
    ]
    render(<ChatPanel messages={messages} parentSessionId="parent-1" socket={null} />)
    expect(screen.getByTestId('sub-agent-row-c1')).toBeTruthy()
    expect(screen.queryByTestId('tool-call-group-c1')).toBeNull()
  })

  it('falls back to the generic ToolCallGroupBlock when no parentSessionId is passed', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: 'c1',
            name: 'agent',
            input: { prompt: 'go look' },
          },
        ],
      },
    ]
    render(<ChatPanel messages={messages} />)
    expect(screen.queryByTestId('sub-agent-row-c1')).toBeNull()
    expect(screen.getByTestId('tool-call-group-c1')).toBeTruthy()
  })

  it('switches to matrix layout when a single assistant message spawns ≥2 sub-agents', () => {
    const group = makeGroup([
      makeCall('c1', { prompt: 'search A', agent_type: 'Explore' }),
      makeCall('c2', { prompt: 'search B', agent_type: 'Explore' }),
      makeCall('c3', { prompt: 'search C', agent_type: 'Explore' }),
    ])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    const matrix = screen.getByTestId(`sub-agent-matrix-${group.firstCallId}`)
    expect(matrix.className).toContain('grid')
    expect(matrix.className).toContain('sm:grid-cols-2')
    expect(screen.getByTestId('sub-agent-row-c1')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-row-c2')).toBeTruthy()
    expect(screen.getByTestId('sub-agent-row-c3')).toBeTruthy()
  })

  it('keeps single-agent groups in the stacked list layout (no matrix)', () => {
    const group = makeGroup([makeCall('c1', { prompt: 'search' })])
    render(
      <SubAgentCard
        parentSessionId="parent-1"
        socket={null}
        group={group}
        approvalByCallId={new Map()}
      />,
    )
    expect(screen.queryByTestId(`sub-agent-matrix-${group.firstCallId}`)).toBeNull()
    expect(screen.getByTestId('sub-agent-row-c1')).toBeTruthy()
  })
})

function makeControlledSocket(): {
  socket: DashboardSocket
  emit: ReturnType<typeof vi.fn>
  emitStarted: (payload: Record<string, unknown>) => void
  emitFinished: (payload: Record<string, unknown>) => void
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const emit = vi.fn(function emit() {
    return socket
  })
  const socket = {
    on(event: string, listener: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return this
    },
    off(event: string, listener: (payload: unknown) => void) {
      listeners.get(event)?.delete(listener)
      return this
    },
    emit,
  } as unknown as DashboardSocket
  return {
    socket,
    emit,
    emitStarted(payload) {
      for (const listener of listeners.get('server:control_update') ?? []) {
        listener({ kind: 'sub_agent_started', ...payload })
      }
    },
    emitFinished(payload) {
      for (const listener of listeners.get('server:control_update') ?? []) {
        listener({ kind: 'sub_agent_finished', ...payload })
      }
    },
  }
}

function makeImmediateReadySocket(childSessionId: string, messages: Message[]): DashboardSocket {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  return {
    on(event: string, listener: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return this
    },
    off(event: string, listener: (payload: unknown) => void) {
      listeners.get(event)?.delete(listener)
      return this
    },
    emit(event: string, payload: { sessionId?: string }) {
      if (event === 'subscribe' && payload.sessionId === childSessionId) {
        for (const listener of listeners.get('session:ready') ?? []) {
          listener({
            sessionId: childSessionId,
            config: { tools: [], systemPrompt: '' },
            state: {
              sessionId: childSessionId,
              messages,
              pendingCalls: [],
              status: 'idle',
              usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
              cursor: messages.length,
              memory: [],
              approvalMode: 'auto',
            },
          })
        }
      }
      return this
    },
  } as unknown as DashboardSocket
}

function makeRecoveringSocket(input: {
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  messages: Message[]
}): DashboardSocket {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  return {
    on(event: string, listener: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return this
    },
    off(event: string, listener: (payload: unknown) => void) {
      listeners.get(event)?.delete(listener)
      return this
    },
    emit(event: string, payload: { parentSessionId?: string; sessionId?: string }, ack?: (payload: unknown) => void) {
      if (event === 'sub_agent:list' && payload.parentSessionId === input.parentSessionId && ack) {
        ack({
          requestId: 'recover',
          parentSessionId: input.parentSessionId,
          children: [
            {
              childSessionId: input.childSessionId,
              parentCallId: input.parentCallId,
              agentType: 'Explore',
              status: 'running',
              startedAt: new Date().toISOString(),
            },
          ],
        })
      }
      if (event === 'subscribe' && payload.sessionId === input.childSessionId) {
        for (const listener of listeners.get('session:ready') ?? []) {
          listener({
            sessionId: input.childSessionId,
            config: { tools: [], systemPrompt: '' },
            state: {
              sessionId: input.childSessionId,
              messages: input.messages,
              pendingCalls: [],
              status: 'thinking',
              usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
              cursor: input.messages.length,
              memory: [],
              approvalMode: 'auto',
            },
          })
        }
      }
      return this
    },
  } as unknown as DashboardSocket
}
