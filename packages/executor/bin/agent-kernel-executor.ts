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
 *   AGENT_KERNEL_AUTO_UPDATE / --auto-update
 *     optional; update the release asset from the latest GitHub Release before connecting.
 *   AGENT_KERNEL_NO_UPDATE_CHECK / --no-update-check
 *     optional; disable the default latest-release reminder.
 *
 * The executor is a daemon: it does NOT bind to a sessionId at startup.
 * The host routes `tool:call` messages to it for any session whose
 * `workspaceId` matches this executor's stored workspace id.
 */

import process from 'node:process'

import { startExecutor } from '../src/client.js'
import { createRuntimeLogger } from '../src/logger.js'
import { checkExecutorUpdate } from '../src/update.js'

const logger = createRuntimeLogger('agent-kernel-executor')

type Args = {
  host?: string
  name?: string
  sandboxRoots: string[]
  token?: string
  id?: string
  autoUpdate?: boolean
  noUpdateCheck?: boolean
  updateRepo?: string
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { sandboxRoots: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') continue
    const eq = a.indexOf('=')
    const [key, inline] =
      eq === -1 ? [a, undefined] : [a.slice(0, eq), a.slice(eq + 1)]
    switch (key) {
      case '--auto-update':
        out.autoUpdate = true
        break
      case '--no-update-check':
        out.noUpdateCheck = true
        break
      case '--host':
      case '--name':
      case '--sandbox-root':
      case '--token':
      case '--id':
      case '--update-repo': {
        const value = inline ?? argv[++i]
        if (value === undefined) break
        if (key === '--host') out.host = value
        else if (key === '--name') out.name = value
        else if (key === '--sandbox-root') out.sandboxRoots.push(value)
        else if (key === '--token') out.token = value
        else if (key === '--id') out.id = value
        else out.updateRepo = value
        break
      }
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
  const autoUpdate = args.autoUpdate === true || process.env.AGENT_KERNEL_AUTO_UPDATE === '1'
  const noUpdateCheck = args.noUpdateCheck === true || process.env.AGENT_KERNEL_NO_UPDATE_CHECK === '1'
  const updateRepo = args.updateRepo ?? process.env.AGENT_KERNEL_UPDATE_REPO ?? 'OWNER/REPO'

  if (!host) {
    logger.error(
      'usage: agent-kernel-executor --host <url> [--name <workspace>] [--sandbox-root <path>]...; or set HOST_URL env var',
    )
    process.exit(1)
  }

  if (!noUpdateCheck && process.env.AGENT_KERNEL_SKIP_UPDATE_ONCE !== '1') {
    try {
      await checkExecutorUpdate({
        repo: updateRepo,
        currentTag: process.env.AGENT_KERNEL_RELEASE_TAG,
        autoUpdate,
        argv: process.argv.slice(2),
        logger,
      })
    } catch (err) {
      logger.warn({ err }, 'executor update check failed')
    }
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
