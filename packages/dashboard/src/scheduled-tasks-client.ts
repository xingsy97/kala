export type ScheduleSpec =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; timezone: string; hour: number; minute: number }
  | { kind: 'weekly'; timezone: string; daysOfWeek: number[]; hour: number; minute: number }

export type ScheduledTaskTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'workspace'; workspaceId: string; workspaceName?: string; cwd?: string }

export type ScheduledTask = {
  id: string
  status: 'active' | 'paused'
  prompt: string
  target: ScheduledTaskTarget
  schedule: ScheduleSpec
  nextRunAt: string | null
  createdBy?: string
  createdAt?: string
  updatedAt?: string
}

export type ScheduledRun = {
  occurrenceId: string
  taskId: string
  operationId: string
  scheduledFor: string
  status: 'claimed' | 'enqueued' | 'failed' | 'needs_review' | 'skipped'
  sessionId?: string
  error?: string
}

export type ScheduledTaskDraft = Pick<ScheduledTask, 'prompt' | 'target' | 'schedule'>
export type ScheduledTaskPatch = Partial<ScheduledTaskDraft>

export type ScheduledTasksClient = {
  list(): Promise<readonly ScheduledTask[]>
  create(input: ScheduledTaskDraft): Promise<ScheduledTask>
  update(taskId: string, input: ScheduledTaskPatch): Promise<ScheduledTask>
  pause(taskId: string): Promise<ScheduledTask>
  resume(taskId: string): Promise<ScheduledTask>
  delete(taskId: string): Promise<void>
  history(taskId: string): Promise<readonly ScheduledRun[]>
}

export function createScheduledTasksClient(input: { host: string; token?: string }): ScheduledTasksClient {
  const base = `${input.host.replace(/\/$/u, '')}/api/v1/scheduled-tasks`
  const request = async <T>(path = '', init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string | { message?: string }; message?: string } | null
      const detail = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message
      throw new Error(detail ?? `Scheduled tasks request returned ${response.status}`)
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  return {
    async list() { return (await request<{ items: ScheduledTask[] }>()).items },
    async create(draft) { return (await request<{ task: ScheduledTask }>('', { method: 'POST', body: JSON.stringify(draft) })).task },
    async update(taskId, patch) { return (await request<{ task: ScheduledTask }>(`/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(patch) })).task },
    async pause(taskId) { return (await request<{ task: ScheduledTask }>(`/${encodeURIComponent(taskId)}/pause`, { method: 'POST' })).task },
    async resume(taskId) { return (await request<{ task: ScheduledTask }>(`/${encodeURIComponent(taskId)}/resume`, { method: 'POST' })).task },
    async delete(taskId) { await request<void>(`/${encodeURIComponent(taskId)}`, { method: 'DELETE' }) },
    async history(taskId) { return (await request<{ items: ScheduledRun[] }>(`/${encodeURIComponent(taskId)}/history`)).items },
  }
}
