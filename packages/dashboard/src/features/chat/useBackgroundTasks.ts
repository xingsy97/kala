/**
 * Live view of the executor's background-shell registry.
 *
 * Reconciles three sources into a single `Map<taskId, LiveBackgroundTask>`:
 *
 *  1. `bg:list` (RPC on mount / workspace change) — reset baseline.
 *  2. `server:bg_task_updated` (push) — appends output deltas, updates status.
 *  3. `bg:output` (poll every 1.5s for the *selected* task) — closes any gap
 *     between the tail we already hold and whatever the executor has now.
 *
 * When there's no socket or no workspace attached, the hook returns an empty
 * map — the panel's fallback (timeline-derived tasks) takes over from there.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  BackgroundTaskStatus,
  BackgroundTaskSummary,
  BgKillResult,
  BgOutputResult,
  ServerBgTaskEvicted,
  ServerBgTaskUpdated,
} from '@agent-kernel/shared'

import type { DashboardSocket } from '../../session.js'

export type LiveBackgroundTask = BackgroundTaskSummary & {
  /** Tail of stdout+stderr held on the client (may be less than bytesLogged when the ring buffer wrapped). */
  output: string
  /** Byte offset within `bytesLogged` where the next append/poll should start. */
  nextOffset: number
  /** True while a kill RPC is in flight, so the UI can disable the button. */
  killing: boolean
}

type Params = {
  socket: DashboardSocket | null
  workspaceId: string | undefined
  sessionId: string | null
  selectedTaskId: string | null
  /** Poll interval for the selected task's tail. Injectable for tests. */
  pollIntervalMs?: number
}

const DEFAULT_POLL_MS = 1500

export type UseBackgroundTasksResult = {
  tasks: readonly LiveBackgroundTask[]
  killTask: (taskId: string) => Promise<BgKillResult | null>
}

export function useBackgroundTasks({
  socket,
  workspaceId,
  sessionId,
  selectedTaskId,
  pollIntervalMs = DEFAULT_POLL_MS,
}: Params): UseBackgroundTasksResult {
  const [tasks, setTasks] = useState<ReadonlyMap<string, LiveBackgroundTask>>(
    () => new Map(),
  )
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  const setTask = useCallback(
    (taskId: string, update: (prev: LiveBackgroundTask | undefined) => LiveBackgroundTask | null) => {
      setTasks((prev) => {
        const next = new Map(prev)
        const updated = update(next.get(taskId))
        if (updated === null) {
          next.delete(taskId)
        } else {
          next.set(taskId, updated)
        }
        return next
      })
    },
    [],
  )

  useEffect(() => {
    if (!socket || !workspaceId || !sessionId) {
      setTasks(new Map())
      return
    }

    let cancelled = false

    // Baseline: fetch the full list once the workspace binding is known.
    socket.emit(
      'bg:list',
      { requestId: requestId(), workspaceId, sessionId },
      (result) => {
        if (cancelled || result.error || !result.tasks) return
        setTasks((prev) => {
          const next = new Map<string, LiveBackgroundTask>()
          for (const summary of result.tasks) {
            const existing = prev.get(summary.taskId)
            next.set(summary.taskId, {
              ...summary,
              output: existing?.output ?? '',
              nextOffset: existing?.nextOffset ?? 0,
              killing: existing?.killing ?? false,
            })
          }
          return next
        })
      },
    )

    const onUpdate = (payload: ServerBgTaskUpdated): void => {
      if (payload.workspaceId !== workspaceId || payload.sessionId !== sessionId) return
      setTask(payload.task.taskId, (prev) => {
        const base: LiveBackgroundTask = prev ?? {
          ...payload.task,
          output: '',
          nextOffset: 0,
          killing: false,
        }
        const merged: LiveBackgroundTask = {
          ...base,
          ...payload.task,
          killing: base.killing && payload.task.status === 'running',
        }
        if (payload.delta) {
          const expectedOffset = base.nextOffset
          if (payload.delta.fromOffset === expectedOffset) {
            merged.output = base.output + payload.delta.content
            merged.nextOffset =
              payload.delta.fromOffset + payload.delta.content.length
          } else if (payload.delta.fromOffset < expectedOffset) {
            // Overlap or duplicate: skip the already-seen prefix.
            const overlap = expectedOffset - payload.delta.fromOffset
            const remainder = payload.delta.content.slice(overlap)
            merged.output = base.output + remainder
            merged.nextOffset = expectedOffset + remainder.length
          } else {
            // Gap: we missed some bytes. Keep what we have and rely on the
            // selection-driven poll below to refetch on demand.
            merged.output = base.output
            merged.nextOffset = base.nextOffset
          }
        }
        return merged
      })
    }

    const onEvicted = (payload: ServerBgTaskEvicted): void => {
      if (payload.workspaceId !== workspaceId || payload.sessionId !== sessionId) return
      setTask(payload.taskId, () => null)
    }

    socket.on('server:bg_task_updated', onUpdate)
    socket.on('server:bg_task_evicted', onEvicted)

    return () => {
      cancelled = true
      socket.off('server:bg_task_updated', onUpdate)
      socket.off('server:bg_task_evicted', onEvicted)
    }
  }, [socket, workspaceId, sessionId, setTask])

  // Poll the selected task's tail. Push events fill in most updates, but the
  // poll closes gaps (e.g. we just selected a task that had been idle) and
  // gives users a predictable refresh cadence when the executor is quiet.
  useEffect(() => {
    if (!socket || !workspaceId || !sessionId || !selectedTaskId) return
    let disposed = false

    const tick = (): void => {
      const current = tasksRef.current.get(selectedTaskId)
      const offset = current?.nextOffset ?? 0
      socket.emit(
        'bg:output',
        { requestId: requestId(), workspaceId, sessionId, taskId: selectedTaskId, offset },
        (result: BgOutputResult) => {
          if (disposed || result.error) return
          setTask(selectedTaskId, (prev) => {
            if (!prev) return null
            const nextOutput =
              result.content.length > 0 ? prev.output + result.content : prev.output
            return {
              ...prev,
              output: nextOutput,
              nextOffset: result.nextOffset,
              status: result.status,
              bytesTruncated: result.bytesTruncated,
              killing: prev.killing && result.status === 'running',
            }
          })
        },
      )
    }

    tick()
    const handle = window.setInterval(tick, pollIntervalMs)
    return () => {
      disposed = true
      window.clearInterval(handle)
    }
  }, [socket, workspaceId, sessionId, selectedTaskId, pollIntervalMs, setTask])

  const killTask = useCallback(
    async (taskId: string): Promise<BgKillResult | null> => {
      if (!socket || !workspaceId || !sessionId) return null
      setTask(taskId, (prev) => (prev ? { ...prev, killing: true } : prev ?? null))
      return await new Promise<BgKillResult | null>((resolve) => {
        socket.emit(
          'bg:kill',
          { requestId: requestId(), workspaceId, sessionId, taskId },
          (result: BgKillResult) => {
            if (!result.killed) {
              setTask(taskId, (prev) => (prev ? { ...prev, killing: false } : prev ?? null))
            }
            resolve(result)
          },
        )
      })
    },
    [socket, workspaceId, sessionId, setTask],
  )

  const list = useMemo(() => {
    return [...tasks.values()].sort((a, b) => {
      // Running tasks first, then most recently ended.
      if (a.status === 'running' && b.status !== 'running') return -1
      if (a.status !== 'running' && b.status === 'running') return 1
      const at = a.endedAt ?? a.startedAt
      const bt = b.endedAt ?? b.startedAt
      return bt.localeCompare(at)
    })
  }, [tasks])

  return { tasks: list, killTask }
}

export function statusLabel(status: BackgroundTaskStatus): string {
  return status
}

function requestId(): string {
  return crypto.randomUUID()
}
