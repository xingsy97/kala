import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DagRun, ServerDagRunEvent } from '@agent-kernel/shared'

import { DagRunPanel } from './DagRunPanel.js'

describe('DagRunPanel', () => {
  it('renders authoritative graph updates and opens child Sessions', async () => {
    let listener: ((event: ServerDagRunEvent) => void) | undefined
    const emitWithAck = vi.fn(async (event: string) => ({ ok: true, value: event === 'client:list_dag_runs' ? [] : null }))
    const socket = {
      active: true,
      connected: true,
      on: vi.fn((_event: string, callback: (event: ServerDagRunEvent) => void) => { listener = callback }),
      off: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck })),
    }
    const onOpenSession = vi.fn()
    render(<DagRunPanel socket={socket as never} sessionId="parent" onOpenSession={onOpenSession} />)

    expect(screen.getByText('Ready for an objective')).toBeTruthy()
    expect(screen.getByTestId('dag-run-panel').className).toContain('h-full')
    act(() => listener?.({
      sessionId: 'parent',
      run: {
        id: 'run',
        parentSessionId: 'parent',
        objective: 'Ship',
        status: 'running',
        graphVersion: 1,
        resultNodeId: 'review',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        nodes: [{
          id: 'node',
          runId: 'run',
          title: 'Implement',
          instructions: 'Implement it',
          status: 'running',
          depth: 0,
          writeScopes: ['src'],
          attempt: 1,
          childSessionId: 'child',
          progress: 'Running',
          toolActivity: [],
        }, {
          id: 'review',
          runId: 'run',
          title: 'Review',
          instructions: 'Review it',
          status: 'pending',
          depth: 1,
          writeScopes: [],
          attempt: 0,
          toolActivity: [],
        }],
        edges: [{ id: 'edge', runId: 'run', source: 'node', target: 'review' }],
        decisions: [],
        events: [],
        attempts: [{
          id: 1,
          runId: 'run',
          nodeId: 'node',
          attempt: 1,
          workerId: 'worker',
          status: 'running',
          startedAt: '2026-01-01T00:00:01.000Z',
        }],
      } satisfies DagRun,
    }))

    expect(screen.getByText('running · v1')).toBeTruthy()
    expect(screen.getByTestId('dag-edge-node-review')).toBeTruthy()
    fireEvent.click(screen.getByTestId('dag-node-node'))
    fireEvent.click(screen.getByRole('button', { name: 'Open worker Session' }))
    expect(onOpenSession).toHaveBeenCalledWith('child')
  })

  it('ignores updates for another parent Session', () => {
    let listener: ((event: ServerDagRunEvent) => void) | undefined
    const socket = {
      active: true,
      connected: true,
      on: vi.fn((_event: string, callback: (event: ServerDagRunEvent) => void) => { listener = callback }),
      off: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck: async (event: string) => ({ ok: true, value: event === 'client:list_dag_runs' ? [] : null }) })),
    }
    render(<DagRunPanel socket={socket as never} sessionId="parent" onOpenSession={() => {}} />)
    act(() => listener?.({ sessionId: 'other', run: {} as DagRun }))
    expect(screen.getByText('Ready for an objective')).toBeTruthy()
  })

  it('opens a completed Run on its full result instead of the first node', () => {
    let listener: ((event: ServerDagRunEvent) => void) | undefined
    const socket = {
      active: true,
      connected: true,
      on: vi.fn((_event: string, callback: (event: ServerDagRunEvent) => void) => { listener = callback }),
      off: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck: async (event: string) => ({ ok: true, value: event === 'client:list_dag_runs' ? [] : null }) })),
    }
    render(<DagRunPanel socket={socket as never} sessionId="parent" onOpenSession={() => {}} />)
    act(() => listener?.({
      sessionId: 'parent',
      run: {
        id: 'run',
        parentSessionId: 'parent',
        objective: 'Explain the repository',
        status: 'completed',
        graphVersion: 1,
        resultNodeId: 'synthesis',
        result: '# Final answer\n\nThis is the complete conclusion.',
        completedAt: '2026-01-01T00:01:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        nodes: [{
          id: 'synthesis',
          runId: 'run',
          title: 'Synthesize',
          instructions: 'Return the answer',
          status: 'succeeded',
          depth: 0,
          writeScopes: [],
          attempt: 1,
          result: 'This is the complete conclusion.',
          toolActivity: [],
        }],
        edges: [],
        decisions: [],
        events: [],
        attempts: [],
      },
    }))

    expect(screen.getByTestId('dag-result-view')).toBeTruthy()
    expect(screen.getByTestId('dag-final-result').textContent).toContain('This is the complete conclusion.')
    expect(screen.queryByTestId('dag-run-canvas')).toBeNull()
  })
})
