export type ScheduleSpec =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; timezone: string; hour: number; minute: number }
  | { kind: 'weekly'; timezone: string; daysOfWeek: number[]; hour: number; minute: number }

export type ScheduledTaskTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'workspace'; workspaceId: string; workspaceName?: string; cwd?: string }

export type ScheduledTaskStatus = 'active' | 'paused'

export type ScheduledTask = {
  id: string
  generation: number
  ownerKey: string
  createdBy: string
  status: ScheduledTaskStatus
  prompt: string
  target: ScheduledTaskTarget
  schedule: ScheduleSpec
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
}

export type ScheduledTaskSnapshot = Pick<ScheduledTask, 'id' | 'generation' | 'ownerKey' | 'createdBy' | 'prompt' | 'target'>

export type ScheduledRunStatus = 'claimed' | 'enqueued' | 'failed' | 'needs_review' | 'skipped'

export type ScheduledRun = {
  occurrenceId: string
  taskId: string
  operationId: string
  scheduledFor: string
  status: ScheduledRunStatus
  claimedAt: string
  updatedAt: string
  /** Immutable definition used for this occurrence, including after restart or task deletion. */
  task: ScheduledTaskSnapshot
  sessionId?: string
  error?: string
}

export type CreateScheduledTask = {
  ownerKey: string
  createdBy: string
  prompt: string
  target: ScheduledTaskTarget
  schedule: ScheduleSpec
}

export type UpdateScheduledTask = Partial<Pick<ScheduledTask, 'prompt' | 'target' | 'schedule'>>

export type OccurrenceReceipt = 'committed' | 'absent' | 'unknown'
