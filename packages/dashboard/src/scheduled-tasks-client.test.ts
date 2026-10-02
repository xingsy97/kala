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

  it('surfaces API errors', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'scheduler unavailable' }), { status: 503 })))
    await expect(createScheduledTasksClient({ host: '' }).list()).rejects.toThrow('scheduler unavailable')
  })
})
