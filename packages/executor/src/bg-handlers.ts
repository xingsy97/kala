/**
 * Background-shell RPC handlers on the executor side.
 *
 * Three ack-based handlers thin-wrap the registry in
 * `./tools/background-shell.ts` for the dashboard's operator-driven view
 * (list-all-tasks / read-tail / kill), plus a subscriber that pushes live
 * task updates upstream through Host → Dashboard fan-out.
 *
 * All handlers return well-formed payloads even on failure so a dashboard
 * with a stale taskId doesn't crash — errors travel in the `error?` field
 * rather than throwing.
 */

import type {
  BgKillResult,
  BgListResult,
  BgOutputResult,
  ClientKillBgTask,
  ClientListBgTasks,
  ClientReadBgOutput,
} from '@agent-kernel/shared'

import {
  getBackgroundTask,
  killBackgroundShell,
  listBackgroundTasks,
  readBackgroundShell,
} from './tools/background-shell.js'

const BG_READ_DEFAULT_MAX_BYTES = 64 * 1024
const BG_READ_HARD_CEILING = 1 * 1024 * 1024

export async function handleBgList(
  payload: ClientListBgTasks,
): Promise<BgListResult> {
  return {
    requestId: payload.requestId,
    workspaceId: payload.workspaceId,
    tasks: listBackgroundTasks(),
  }
}

export async function handleBgOutput(
  payload: ClientReadBgOutput,
): Promise<BgOutputResult> {
  const base = {
    requestId: payload.requestId,
    workspaceId: payload.workspaceId,
    taskId: payload.taskId,
  }
  const summary = getBackgroundTask(payload.taskId)
  if (!summary) {
    return {
      ...base,
      content: '',
      nextOffset: 0,
      done: true,
      status: 'exited',
      bytesTruncated: 0,
      error: 'unknown task',
    }
  }
  const cap = Math.max(
    1,
    Math.min(BG_READ_HARD_CEILING, payload.maxBytes ?? BG_READ_DEFAULT_MAX_BYTES),
  )
  try {
    const raw = await readBackgroundShell({
      taskId: payload.taskId,
      ...(payload.offset !== undefined ? { offset: payload.offset } : {}),
      block: false,
    })
    const slice =
      raw.content.length > cap
        ? raw.content.slice(raw.content.length - cap)
        : raw.content
    return {
      ...base,
      content: slice,
      nextOffset: raw.nextOffset,
      done: raw.done,
      status: raw.status,
      bytesTruncated: raw.bytesTruncated,
    }
  } catch (err) {
    return {
      ...base,
      content: '',
      nextOffset: 0,
      done: true,
      status: summary.status,
      bytesTruncated: summary.bytesTruncated,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function handleBgKill(
  payload: ClientKillBgTask,
): Promise<BgKillResult> {
  const base = {
    requestId: payload.requestId,
    workspaceId: payload.workspaceId,
    taskId: payload.taskId,
  }
  try {
    const killed = await killBackgroundShell(payload.taskId)
    return { ...base, killed }
  } catch (err) {
    return {
      ...base,
      killed: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
