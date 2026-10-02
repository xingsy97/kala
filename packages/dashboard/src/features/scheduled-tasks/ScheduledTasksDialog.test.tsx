import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ScheduledRun, ScheduledTask, ScheduledTasksClient } from '../../scheduled-tasks-client.js'
import { ScheduledTasksDialog, ScheduledTasksTrigger } from './ScheduledTasksDialog.js'

const activeTask: ScheduledTask = {
  id: 'task-1',
  status: 'active',
  prompt: 'Summarize progress',
  target: { kind: 'session', sessionId: 'session-1' },
  schedule: { kind: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
  nextRunAt: '2026-10-03T09:00:00.000Z',
}

const run: ScheduledRun = {
  occurrenceId: 'occurrence-1',
  taskId: 'task-1',
  operationId: 'operation-1',
  scheduledFor: '2026-10-02T09:00:00.000Z',
  status: 'enqueued',
  sessionId: 'session-run-1',
}

function mockClient(initial: readonly ScheduledTask[] = []): ScheduledTasksClient & { tasks: ScheduledTask[] } {
  const result = {
    tasks: [...initial],
    list: vi.fn(async () => result.tasks),
    create: vi.fn(async (draft) => {
      const created: ScheduledTask = { id: 'created', status: 'active', nextRunAt: '2026-10-04T09:00:00.000Z', ...draft }
      result.tasks.push(created)
      return created
    }),
    update: vi.fn(async (taskId, patch) => {
      const index = result.tasks.findIndex((item) => item.id === taskId)
      result.tasks[index] = { ...result.tasks[index]!, ...patch }
      return result.tasks[index]!
    }),
    pause: vi.fn(async (taskId) => {
      const index = result.tasks.findIndex((item) => item.id === taskId)
      result.tasks[index] = { ...result.tasks[index]!, status: 'paused' }
      return result.tasks[index]!
    }),
    resume: vi.fn(async (taskId) => {
      const index = result.tasks.findIndex((item) => item.id === taskId)
      result.tasks[index] = { ...result.tasks[index]!, status: 'active' }
      return result.tasks[index]!
    }),
    delete: vi.fn(async (taskId) => { result.tasks = result.tasks.filter((item) => item.id !== taskId) }),
    history: vi.fn(async () => [run]),
  } satisfies ScheduledTasksClient & { tasks: ScheduledTask[] }
  return result
}

function renderDialog(client: ScheduledTasksClient, target: ScheduledTask['target'] = activeTask.target, onOpenSession = vi.fn()) {
  return render(<ScheduledTasksDialog open onOpenChange={() => {}} host="https://runlab.example" target={target} client={client} onOpenSession={onOpenSession} />)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScheduledTasksDialog', () => {
  it('creates a Session task and clearly warns that a busy Session queue waits', async () => {
    const client = mockClient()
    renderDialog(client)
    await screen.findByText(/No scheduled tasks for this session/i)
    expect(screen.getByText(/waits behind existing work/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Review the queue' } })
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'daily' } })
    fireEvent.change(screen.getByLabelText('IANA timezone'), { target: { value: 'America/New_York' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(client.create).toHaveBeenCalled())
    expect(vi.mocked(client.create).mock.calls[0]![0]).toMatchObject({
      prompt: 'Review the queue',
      target: { kind: 'session', sessionId: 'session-1' },
      schedule: { kind: 'daily', timezone: 'America/New_York' },
    })
    expect(await screen.findByText('Review the queue')).toBeTruthy()
  })

  it('creates a workspace task with the server-provided workspace identity and fresh-Session explanation', async () => {
    const client = mockClient()
    renderDialog(client, { kind: 'workspace', workspaceId: 'workspace-1', workspaceName: 'Dev box' })
    await screen.findByText(/No scheduled tasks for this workspace/i)
    expect(screen.getByText(/fresh Session in this workspace/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Run workspace checks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(client.create).toHaveBeenCalled())
    expect(vi.mocked(client.create).mock.calls[0]![0].target).toEqual({ kind: 'workspace', workspaceId: 'workspace-1', workspaceName: 'Dev box' })
  })

  it('pauses, resumes, edits, deletes, and opens linked run history', async () => {
    const client = mockClient([activeTask])
    const onOpenSession = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDialog(client, activeTask.target, onOpenSession)
    await screen.findByText('Summarize progress')

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(client.pause).toHaveBeenCalledWith('task-1'))
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(client.resume).toHaveBeenCalledWith('task-1'))

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Updated summary' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(client.update).toHaveBeenCalledWith('task-1', expect.objectContaining({ prompt: 'Updated summary' })))

    fireEvent.click(await screen.findByRole('button', { name: 'History' }))
    const sessionLink = await screen.findByRole('button', { name: /Open Session session-run-1/i })
    fireEvent.click(sessionLink)
    expect(onOpenSession).toHaveBeenCalledWith('session-run-1')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith('task-1'))
    expect(await screen.findByText(/No scheduled tasks for this session/i)).toBeTruthy()
  })

  it('shows loading and errors, with a retry action', async () => {
    let resolveList!: (tasks: readonly ScheduledTask[]) => void
    const list = vi.fn(() => new Promise<readonly ScheduledTask[]>((resolve) => { resolveList = resolve }))
    const client = { ...mockClient(), list }
    const view = renderDialog(client)
    expect(screen.getByRole('status').textContent).toContain('Loading scheduled tasks')
    resolveList([])
    await screen.findByText(/No scheduled tasks/i)
    view.unmount()

    const failing = mockClient()
    vi.mocked(failing.list).mockRejectedValue(new Error('Cannot load tasks'))
    renderDialog(failing)
    expect((await screen.findByRole('alert')).textContent).toContain('Cannot load tasks')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(failing.list).toHaveBeenCalledTimes(2)
  })

  it('disables scheduling when there is no validated workspace target', () => {
    const onOpen = vi.fn()
    render(<ScheduledTasksTrigger target={null} scope="workspace" onOpen={onOpen} />)
    const trigger = screen.getByRole('button', { name: /Scheduled tasks for this workspace/i })
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(trigger)
    expect(onOpen).not.toHaveBeenCalled()
  })
})
