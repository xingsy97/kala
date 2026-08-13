import type { RpcAck } from '@agent-kernel/shared'

import type { DashboardSocket } from './session.js'
import { randomId } from './lib/random-id.js'

class RpcBusinessError extends Error {}

export async function emitRpc<T = undefined>(
  socket: DashboardSocket,
  event: string,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number; attempts?: number; operationId?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const attempts = options.attempts ?? 3
  const operationId = options.operationId ?? randomId()
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await (socket.timeout(timeoutMs) as unknown as {
        emitWithAck(name: string, body: Record<string, unknown>): Promise<RpcAck<T>>
      }).emitWithAck(event, { ...payload, operationId })
      if (!result.ok) throw new RpcBusinessError(result.error)
      return ('value' in result ? result.value : undefined) as T
    } catch (error) {
      if (error instanceof RpcBusinessError) throw error
      lastError = error
      if (!socket.active && !socket.connected) socket.connect()
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'RPC failed'))
}

export function emitRpcInBackground(
  socket: DashboardSocket,
  event: string,
  payload: Record<string, unknown>,
): void {
  void emitRpc(socket, event, payload).catch(() => {
    // Authoritative pushes/session:error surface business failures. Background
    // callers intentionally keep their existing fire-and-forget UI contract.
  })
}
