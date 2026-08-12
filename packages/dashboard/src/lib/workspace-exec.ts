/**
 * Thin dashboard-side client for the generic workspace:exec /
 * workspace:read_binary sockets (docs/planning/roadmap-notes/
 * workspace-exec-refactor.md).
 *
 * Replaces the per-feature request helpers scattered across
 * SourceControlPanel / SessionFilesPanel / useBackgroundTasks. All
 * domain parsing (git porcelain, ls output, bg task list) now runs in
 * the dashboard on top of these two primitives.
 */

import { randomId } from './random-id.js'
import { dashboardConnectionManager } from '../session.js'
import type { Socket } from 'socket.io-client'

import type {
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
} from '@agent-kernel/shared'
import type {
  WorkspaceExecRequest,
  WorkspaceExecResponse,
  WorkspaceReadBinaryRequest,
  WorkspaceReadBinaryResponse,
} from '@agent-kernel/shared/workspace-exec'

export type WorkspaceSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

export type WorkspaceExecOptions = {
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  stdin?: string
  /** Ack timeout — how long to wait for the host round-trip. Defaults to
   *  `timeoutMs + 2000` so the ack always outlasts a legitimate command. */
  ackTimeoutMs?: number
}

const DEFAULT_ACK_BUFFER_MS = 2_000

async function ensureWorkspaceSubscription(socket: WorkspaceSocket, workspaceId: string): Promise<() => void> {
  // Lightweight feature-test sockets used by isolated panels predate channel
  // subscriptions; production Socket.IO sockets always provide on/off.
  if (typeof socket.on !== 'function' || typeof socket.off !== 'function' || !('io' in socket)) return () => {}
  const manager = dashboardConnectionManager(socket)
  const release = manager.acquire(`workspace:${workspaceId}`)
  const deadline = Date.now() + 1_500
  while (Date.now() < deadline) {
    const state = manager.snapshot().get(`workspace:${workspaceId}`)?.state
    if (state === 'active' || state === 'rejected') break
    await new Promise((resolve) => window.setTimeout(resolve, 10))
  }
  return release
}

export async function workspaceExec(
  socket: WorkspaceSocket,
  workspaceId: string,
  argv: readonly string[],
  options: WorkspaceExecOptions = {},
): Promise<WorkspaceExecResponse> {
  const releaseSubscription = await ensureWorkspaceSubscription(socket, workspaceId)
  const requestId = randomId()
  const payload: WorkspaceExecRequest = {
    requestId,
    workspaceId,
    argv,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.stdin ? { stdin: options.stdin } : {}),
  }
  const ackTimeout = options.ackTimeoutMs ?? ((options.timeoutMs ?? 15_000) + DEFAULT_ACK_BUFFER_MS)
  return await new Promise<WorkspaceExecResponse>((resolve) => {
    const timer = window.setTimeout(() => {
      releaseSubscription()
      resolve({
        requestId,
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: ackTimeout,
        error: { code: 'ETIMEDOUT', message: `dashboard ack timeout after ${ackTimeout}ms` },
      })
    }, ackTimeout)
    socket.emit('workspace:exec', payload, (result: WorkspaceExecResponse) => {
      window.clearTimeout(timer)
      releaseSubscription()
      resolve(result)
    })
  })
}

export type WorkspaceReadBinaryOptions = {
  cwd?: string
  maxBytes?: number
  ackTimeoutMs?: number
}

export async function workspaceReadBinary(
  socket: WorkspaceSocket,
  workspaceId: string,
  path: string,
  options: WorkspaceReadBinaryOptions = {},
): Promise<WorkspaceReadBinaryResponse> {
  const releaseSubscription = await ensureWorkspaceSubscription(socket, workspaceId)
  const requestId = randomId()
  const payload: WorkspaceReadBinaryRequest = {
    requestId,
    workspaceId,
    path,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  }
  const ackTimeout = options.ackTimeoutMs ?? 12_000
  return await new Promise<WorkspaceReadBinaryResponse>((resolve) => {
    const timer = window.setTimeout(() => {
      releaseSubscription()
      resolve({
        requestId,
        base64: '',
        mime: 'application/octet-stream',
        size: 0,
        error: { code: 'EACCES', message: `dashboard ack timeout after ${ackTimeout}ms` },
      })
    }, ackTimeout)
    socket.emit('workspace:read_binary', payload, (result: WorkspaceReadBinaryResponse) => {
      window.clearTimeout(timer)
      releaseSubscription()
      resolve(result)
    })
  })
}
