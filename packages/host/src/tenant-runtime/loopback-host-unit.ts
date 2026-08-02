import { startExecutor, type ExecutorHandle } from '@agent-kernel/executor'
import { join } from 'node:path'
import type { HostServer, HostServerOptions } from '../server.js'
import { ExecutorIdentityStore } from '../store/executor-identity.js'
import { startHostServer } from '../server.js'
import type { TenantRuntimeUnit, TenantRuntimeUnitId, TenantRuntimeUnitState } from './unit.js'

export type LoopbackHostRuntimeUnit = TenantRuntimeUnit & {
  readonly server: HostServer
  readonly executor?: ExecutorHandle
}

/**
 * Transitional composition: one complete existing Host runtime is hosted behind
 * a private loopback listener and exposed as one TenantRuntimeUnit. This keeps
 * all mature Agent behavior intact while the outer multi-tenant Host owns only
 * routing and lifecycle. Later extraction can lift immutable/static services
 * out without changing the Unit contract.
 */
export async function startLoopbackHostRuntimeUnit(
  id: TenantRuntimeUnitId,
  options: Omit<HostServerOptions, 'port' | 'httpServer'> & { workspaceDir?: string; executorIdentityStorePath?: string },
): Promise<LoopbackHostRuntimeUnit> {
  let state: TenantRuntimeUnitState = 'loading'
  const { workspaceDir, executorIdentityStorePath, ...serverOptions } = options
  const executorIdentityStore = executorIdentityStorePath ? new ExecutorIdentityStore(executorIdentityStorePath) : undefined
  executorIdentityStore?.load()
  const workspaceId = `${id}-workspace`
  const executorToken = workspaceDir && executorIdentityStore ? executorIdentityStore.provisionWorkspace(workspaceId, 'Workspace') : undefined
  const server = await startHostServer({
    ...serverOptions,
    ...(executorIdentityStore ? { auth: { ...(serverOptions.auth ?? {}), executorIdentityStore } } : {}),
    port: 0,
    listenHost: '127.0.0.1',
    deploymentMode: options.deploymentMode ?? 'saas',
  })
  const executor = workspaceDir ? startExecutor({
    host: `http://127.0.0.1:${server.port}`,
    workspaceId,
    workspaceName: 'Workspace',
    sandboxRoots: [workspaceDir],
    // Hosted loopback execution still performs real filesystem mutations. Keep
    // durable scoped receipts so Unit/Host restart cannot execute them twice.
    receiptStorePath: join(workspaceDir, '.agent-kernel', 'execution-receipts.json'),
    ...(executorToken ? { token: executorToken } : {}),
  }) : undefined
  if (executor) {
    await executor.ready
    const deadline = Date.now() + 10_000
    while (!server.executorsSnapshot().some((attached) => attached.workspaceId === executor.workspaceId)) {
      if (Date.now() >= deadline) {
        executor.close()
        await server.close()
        throw new Error(`TenantRuntimeUnit ${id} executor announcement timed out`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  state = 'ready'
  let closed = false
  return {
    id,
    get state() { return state },
    origin: `http://127.0.0.1:${server.port}`,
    server,
    ...(executor ? { executor } : {}),
    async drain() {
      if (closed || state === 'draining') return
      state = 'draining'
      server.loop.beginDrain('checkpoint')
      const sessions = server.store.list()
      await Promise.all(sessions.map(async (session) => {
        const snapshot = server.loop.drainSnapshot(session.sessionId)
        if (!snapshot.safe) await server.loop.waitForCheckpoint(session.sessionId)
      }))
    },
    async close() {
      if (closed) return
      closed = true
      state = 'draining'
      executor?.close()
      await server.close()
      state = 'closed'
    },
  }
}
