import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
      { role: 'assistant', content: [{ type: 'text', text: 'child answer visible' }] },
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
    await waitFor(() => expect(screen.getByText('child answer visible')).toBeTruthy())
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
  emitStarted: (payload: Record<string, unknown>) => void
  emitFinished: (payload: Record<string, unknown>) => void
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
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
    emit() {
      return this
    },
  } as unknown as DashboardSocket
  return {
    socket,
    emitStarted(payload) {
      for (const listener of listeners.get('server:sub_agent_started') ?? []) listener(payload)
    },
    emitFinished(payload) {
      for (const listener of listeners.get('server:sub_agent_finished') ?? []) listener(payload)
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
              contextPressureLevel: 'none',
              approvalMode: 'auto',
            },
          })
        }
      }
      return this
    },
  } as unknown as DashboardSocket
}
