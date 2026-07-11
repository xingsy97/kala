import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { BgKillResult, BgListResult } from '@agent-kernel/shared'

import type { DashboardSocket } from '../../session.js'
import { BackgroundShellsButton } from './BackgroundTerminalPanel.js'

describe('BackgroundShellsButton', () => {
  it('labels live executor tasks as workspace shells', async () => {
    const socket = makeBgListSocket({
      requestId: 'ignored',
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      tasks: [
        {
          taskId: 'task-live-1',
          sessionId: 'sess-1',
              command: 'pnpm dev -- --host 0.0.0.0',
              cwd: '/repo',
              pid: 4242,
              startedAt: '2026-07-07T00:00:00.000Z',
              status: 'running',
          exitCode: null,
          signal: null,
          bytesLogged: 0,
          bytesTruncated: 0,
        },
      ],
    })
    render(
      <BackgroundShellsButton
        socket={socket}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[]}
      />,
    )

    const trigger = await screen.findByTestId('background-shells-trigger')
    expect(trigger.textContent ?? '').toContain('Workspace Shell')
    expect(trigger.getAttribute('aria-label') ?? '').toContain('workspace background shell')

    fireEvent.click(trigger)
    expect(await screen.findByText('Workspace shells')).toBeTruthy()
    expect(screen.getByText(/workspace live · task-live-1/i)).toBeTruthy()
    expect(screen.getByTestId('bg-task-command').textContent ?? '').toContain('pnpm dev -- --host 0.0.0.0')
    expect(screen.getByText('PID')).toBeTruthy()
    expect(screen.getByText('4242')).toBeTruthy()
    expect(screen.getAllByText('running').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('bg-task-kill-selected-task-live-1'))
    expect(socket.emitMock).toHaveBeenCalledWith(
      'bg:kill',
      expect.objectContaining({ workspaceId: 'ws-1', sessionId: 'sess-1', taskId: 'task-live-1' }),
      expect.any(Function),
    )
  })

  it('labels timeline-derived tasks as session replay shells', async () => {
    render(
      <BackgroundShellsButton
        socket={null}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[
          {
            taskId: 'task-replay-1',
            callId: 'call-1',
            command: 'sleep 20',
            status: 'running',
            output: '',
          },
        ]}
      />,
    )

    const trigger = screen.getByTestId('background-shells-trigger')
    expect(trigger.textContent ?? '').toContain('Session replay Shell')
    expect(trigger.getAttribute('aria-label') ?? '').toContain('session replay background shell')

    fireEvent.click(trigger)
    expect(await screen.findByText('Session replay shells')).toBeTruthy()
    expect(screen.getByText(/session replay · task-replay-1/i)).toBeTruthy()
    expect(screen.getByTestId('bg-task-command').textContent ?? '').toContain('sleep 20')

    await waitFor(() => expect(screen.queryByTestId('bg-task-kill-task-replay-1')).toBeNull())
    expect(screen.queryByTestId('bg-task-kill-selected-task-replay-1')).toBeNull()
  })

  it('keeps the trigger for completed live tasks but counts zero running shells', async () => {
    render(
      <BackgroundShellsButton
        socket={makeBgListSocket({
          requestId: 'ignored',
          workspaceId: 'ws-1',
          sessionId: 'sess-1',
          tasks: [
            {
              taskId: 'task-killed-1',
              sessionId: 'sess-1',
              command: 'sleep 100',
              cwd: '/repo',
              pid: 4243,
              startedAt: '2026-07-07T00:00:00.000Z',
              endedAt: '2026-07-07T00:01:00.000Z',
              status: 'killed',
              exitCode: null,
              signal: 'SIGTERM',
              bytesLogged: 0,
              bytesTruncated: 0,
            },
          ],
        })}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[]}
      />,
    )

    const trigger = await screen.findByTestId('background-shells-trigger')
    expect(trigger.textContent ?? '').toContain('0 Workspace Shells')
    expect(trigger.getAttribute('aria-label') ?? '').toContain('0 running workspace background shells')

    fireEvent.click(trigger)
    expect(await screen.findByText('Workspace shells')).toBeTruthy()
    expect(screen.getByText(/workspace live · task-killed-1/i)).toBeTruthy()
    expect(screen.getAllByText('killed').length).toBeGreaterThan(0)
    expect(screen.getByText('4243')).toBeTruthy()
    expect(screen.queryByTestId('bg-task-kill-selected-task-killed-1')).toBeNull()
  })

  it('shows a zero workspace shell trigger when the live registry is empty', async () => {
    render(
      <BackgroundShellsButton
        socket={makeBgListSocket({
          requestId: 'ignored',
          workspaceId: 'ws-1',
          sessionId: 'sess-1',
          tasks: [],
        })}
        workspaceId="ws-1"
        sessionId="sess-1"
        fallbackTasks={[]}
      />,
    )

    const trigger = await screen.findByTestId('background-shells-trigger')
    expect(trigger.textContent ?? '').toContain('0 Workspace Shells')

    fireEvent.click(trigger)
    expect(await screen.findByText('Workspace shells')).toBeTruthy()
    expect(screen.getByTestId('bg-task-empty').textContent ?? '').toContain('No background shells')
  })
})

function makeBgListSocket(result: BgListResult): DashboardSocket & { emitMock: ReturnType<typeof vi.fn> } {
  const socket = {
    emitMock: vi.fn(),
    on() {
      return this
    },
    off() {
      return this
    },
    emit(event: string, _payload: unknown, ack?: (result: BgListResult) => void) {
      this.emitMock(event, _payload, ack)
      if (event === 'bg:list') window.setTimeout(() => ack?.(result), 0)
      if (event === 'bg:kill') window.setTimeout(() => ack?.({ ..._payload, killed: true } as BgKillResult), 0)
      return this
    },
  }
  return socket as unknown as DashboardSocket & { emitMock: ReturnType<typeof vi.fn> }
}
