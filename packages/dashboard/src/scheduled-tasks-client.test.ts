import { afterEach, describe, expect, it, vi } from 'vitest'

import { createScheduledTasksClient, type ScheduledTask } from './scheduled-tasks-client.js'

const task: ScheduledTask = {
  id: 'task-1',
  status: 'active',
  prompt: 'Summarize progress',
  target: { kind: 'session', sessionId: 'session-1' },
  schedule: { kind: 'daily', timezone: 'Europe/London', hour: 9, minute: 30 },
  nextRunAt: '2026-10-03T08:30:00.000Z',
}

afterEach(() => vi.unstubAllGlobals())

describe('createScheduledTasksClient', () => {
  it('uses authenticated host API routes for both target scopes and every lifecycle operation', async () => {
    const responses = [
      new Response(JSON.stringify({ items: [task] }), { status: 200 }),
      new Response(JSON.stringify({ task }), { status: 201 }),
      new Response(JSON.stringify({ task: { ...task, target: { kind: 'workspace', workspaceId: 'workspace-1' } } }), { status: 201 }),
      new Response(JSON.stringify({ task: { ...task, prompt: 'Updated' } }), { status: 200 }),
      new Response(JSON.stringify({ task: { ...task, status: 'paused' } }), { status: 200 }),
      new Response(JSON.stringify({ task }), { status: 200 }),
      new Response(JSON.stringify({ items: [{ occurrenceId: 'occ-1', taskId: 'task-1', operationId: 'op-1', scheduledFor: '2026-10-03T08:30:00.000Z', status: 'enqueued', sessionId: 'session-2' }] }), { status: 200 }),
      new Response(null, { status: 204 }),
    ]
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!)
    vi.stubGlobal('fetch', fetchMock)
    const client = createScheduledTasksClient({ host: 'https://runlab.example/', token: 'secret' })

    await client.list()
    await client.create({ prompt: task.prompt, target: task.target, schedule: task.schedule })
    await client.create({ prompt: 'Workspace report', target: { kind: 'workspace', workspaceId: 'workspace-1', workspaceName: 'Dev box' }, schedule: { kind: 'weekly', timezone: 'UTC', daysOfWeek: [1], hour: 10, minute: 0 } })
    await client.update('task-1', { prompt: 'Updated' })
    await client.pause('task-1')
    await client.resume('task-1')
    await client.history('task-1')
    await client.delete('task-1')

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://runlab.example/api/v1/scheduled-tasks',
      'https://runlab.example/api/v1/scheduled-tasks',
      'https://runlab.example/api/v1/scheduled-tasks',
      'https://runlab.example/api/v1/scheduled-tasks/task-1',
      'https://runlab.example/api/v1/scheduled-tasks/task-1/pause',
      'https://runlab.example/api/v1/scheduled-tasks/task-1/resume',
      'https://runlab.example/api/v1/scheduled-tasks/task-1/history',
      'https://runlab.example/api/v1/scheduled-tasks/task-1',
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ credentials: 'include', headers: expect.objectContaining({ authorization: 'Bearer secret' }) }))
    }
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).target).toEqual({ kind: 'session', sessionId: 'session-1' })
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body)).target).toEqual({ kind: 'workspace', workspaceId: 'workspace-1', workspaceName: 'Dev box' })
    expect(fetchMock.mock.calls[3]![1]?.method).toBe('PATCH')
    expect(fetchMock.mock.calls[7]![1]?.method).toBe('DELETE')
  })

  it('sends interval and monthly schedule fields unchanged', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ task }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createScheduledTasksClient({ host: 'https://runlab.example' })

    await client.create({
      prompt: 'Interval report',
      target: { kind: 'session', sessionId: 'session-1' },
      schedule: { kind: 'interval', timezone: 'America/New_York', hour: 9, minute: 15, everyDays: 3, startDate: '2026-10-04' },
    })
    await client.create({
      prompt: 'Monthly report',
      target: { kind: 'workspace', workspaceId: 'workspace-1' },
      schedule: { kind: 'monthly', timezone: 'Asia/Shanghai', hour: 10, minute: 30, daysOfMonth: [1, 15, 31] },
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).schedule).toEqual({ kind: 'interval', timezone: 'America/New_York', hour: 9, minute: 15, everyDays: 3, startDate: '2026-10-04' })
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).schedule).toEqual({ kind: 'monthly', timezone: 'Asia/Shanghai', hour: 10, minute: 30, daysOfMonth: [1, 15, 31] })
  })

  it('fetches minimal scheduled message origins for one encoded session', async () => {
    const origins = { 'schedule-op-1': 'task-1' }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ origins }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await expect(createScheduledTasksClient({ host: 'https://runlab.example/', token: 'secret' })
      .origins('session / 1', { signal: controller.signal })).resolves.toEqual(origins)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://runlab.example/api/v1/scheduled-tasks/origins?sessionId=session%20%2F%201',
      expect.objectContaining({ credentials: 'include', signal: controller.signal }),
    )
  })

  it('fetches the inbox without acknowledging and acknowledges only supplied occurrence IDs', async () => {
    const inbox = {
      items: [{ occurrenceId: 'occ-1', taskId: 'task-1', status: 'needs_review' as const, scheduledFor: '2026-10-04T09:00:00.000Z', updatedAt: '2026-10-04T09:01:00.000Z', seen: false }],
      unreadCount: 2,
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(inbox), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ acknowledged: ['occ-1'], unreadCount: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createScheduledTasksClient({ host: 'https://runlab.example/', token: 'secret' })
    const getController = new AbortController()
    const seenController = new AbortController()

    await expect(client.inbox({ signal: getController.signal })).resolves.toEqual(inbox)
    await expect(client.markInboxSeen(['occ-1'], { signal: seenController.signal })).resolves.toEqual({ acknowledged: ['occ-1'], unreadCount: 1 })

    expect(fetchMock.mock.calls[0]).toEqual([
      'https://runlab.example/api/v1/scheduled-tasks/inbox',
      expect.objectContaining({ credentials: 'include', signal: getController.signal }),
    ])
    expect(fetchMock.mock.calls[0]![1]?.method).toBeUndefined()
    expect(fetchMock.mock.calls[1]).toEqual([
      'https://runlab.example/api/v1/scheduled-tasks/inbox/seen',
      expect.objectContaining({ method: 'POST', credentials: 'include', signal: seenController.signal }),
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ occurrenceIds: ['occ-1'] })
  })

  it('surfaces API errors', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'scheduler unavailable' }), { status: 503 })))
    await expect(createScheduledTasksClient({ host: '' }).list()).rejects.toThrow('scheduler unavailable')
  })
})
