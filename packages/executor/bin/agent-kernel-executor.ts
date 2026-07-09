#!/usr/bin/env node
/**
 * `agent-kernel-executor` CLI.
 *
 * Env / flags:
 *   HOST_URL / --host           required (e.g. http://localhost:3000)
 *   WORKSPACE_NAME / --name     optional display label; defaults to os.hostname().
 *                               Free to rename — routing uses the workspaceId
 *                               (persisted at ~/.agent-kernel/workspace-id).
 *   SANDBOX_ROOTS / --sandbox-root
 *     optional filesystem jail(s). Absolute path(s). `SANDBOX_ROOTS` is a
 *     `:`-separated list; `--sandbox-root <path>` is repeatable. Empty = no
 *     jail (executor trusts the whole machine).
 *   EXECUTOR_TOKEN / --token    optional; must match host's HOST_AUTH_TOKEN if set
 *   EXECUTOR_ID / --id          optional; defaults to a ULID
 *
 * The executor is a daemon: it does NOT bind to a sessionId at startup.
 * The host routes `tool:call` messages to it for any session whose
 * `workspaceId` matches this executor's stored workspace id.
 */

import process from 'node:process'

import { startExecutor } from '../src/client.js'
import { createRuntimeLogger } from '../src/logger.js'

const logger = createRuntimeLogger('agent-kernel-executor')

type Args = {
  host?: string
  name?: string
  sandboxRoots: string[]
  token?: string
  id?: string
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { sandboxRoots: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const eq = a.indexOf('=')
    const [key, inline] =
      eq === -1 ? [a, undefined] : [a.slice(0, eq), a.slice(eq + 1)]
    const value = inline ?? argv[++i]
    if (value === undefined) continue
    switch (key) {
      case '--host':
        out.host = value
        break
      case '--name':
        out.name = value
        break
      case '--sandbox-root':
        out.sandboxRoots.push(value)
        break
      case '--token':
        out.token = value
        break
      case '--id':
        out.id = value
        break
      default:
        break
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const host = args.host ?? process.env.HOST_URL
  const name = args.name ?? process.env.WORKSPACE_NAME
  const envRoots = process.env.SANDBOX_ROOTS
    ? process.env.SANDBOX_ROOTS.split(':').filter((s) => s.length > 0)
    : []
  const sandboxRoots = args.sandboxRoots.length > 0 ? args.sandboxRoots : envRoots
  const token = args.token ?? process.env.EXECUTOR_TOKEN
  const executorId = args.id ?? process.env.EXECUTOR_ID

  if (!host) {
    logger.error(
      'usage: agent-kernel-executor --host <url> [--name <workspace>] [--sandbox-root <path>]...; or set HOST_URL env var',
    )
    process.exit(1)
  }

  const handle = startExecutor({
    host,
    ...(name !== undefined ? { workspaceName: name } : {}),
    ...(sandboxRoots.length > 0 ? { sandboxRoots } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(executorId !== undefined ? { executorId } : {}),
  })

  handle.socket.on('connect', () => {
    logger.info(
      {
        executorId: handle.executorId,
        workspaceId: handle.workspaceId,
        workspaceName: handle.workspaceName,
        host,
      },
      'executor connected',
    )
  })
  handle.socket.on('disconnect', (reason) => {
    logger.info({ reason }, 'executor disconnected')
  })
  handle.socket.on('session:error', (e) => {
    logger.error({ scope: e.scope }, e.message)
  })

  await handle.ready
  logger.info('executor announced; awaiting tool calls')

  const shutdown = (): void => {
    logger.info('shutting down')
    handle.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  logger.error({ err }, 'fatal error')
  process.exit(1)
})
