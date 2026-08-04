import type { DashboardClientToServerEvents, DashboardServerToClientEvents } from '@agent-kernel/shared'
import type { Socket } from 'socket.io-client'

type DashboardSocket = Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>

export async function waitForExecutor(socket: DashboardSocket, workspaceId: string, timeoutMs: number, pollIntervalMs = 250): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadlineMs = Math.min(timeoutMs, 60_000)
    const timer = setTimeout(() => { cleanup(); reject(new Error('Executor announce timeout')) }, deadlineMs)
    const poll = setInterval(() => socket.emit('client:list_executors', {}), Math.max(1, Math.min(pollIntervalMs, deadlineMs)))
    const onExecutors: DashboardServerToClientEvents['server:executors'] = (payload) => {
      if (payload.executors.some((executor) => executor.workspaceId === workspaceId)) { cleanup(); resolve() }
    }
    const cleanup = () => { clearTimeout(timer); clearInterval(poll); socket.off('server:executors', onExecutors) }
    socket.on('server:executors', onExecutors)
    socket.emit('client:list_executors', {})
  })
}
