#!/usr/bin/env node
/**
 * `agent-kernel-executor` CLI.
 *
 * Env / flags:
 *   HOST_URL / --host           required (e.g. http://localhost:3000)
 *   WORKSPACE_NAME / --name     optional display label; defaults to os.hostname().
 *                               Free to rename  -  routing uses the workspaceId
 *                               (persisted at ~/.agent-kernel/workspace-id).
 *   SANDBOX_ROOTS / --sandbox-root
 *     optional workspace root(s). Absolute path(s). `SANDBOX_ROOTS` is a
 *     `:`-separated list; `--sandbox-root <path>` is repeatable. Session cwd
 *     may be the root itself or any child directory. Empty = no jail
 *     (executor trusts the whole machine).
 *   EXECUTOR_TOKEN / --token    optional long-term executor token
 *   EXECUTOR_INVITE / --invite  optional one-time invite token from Dashboard
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import lockfile from 'proper-lockfile'

import { startExecutor } from '../src/client.js'
import { createRuntimeLogger } from '../src/logger.js'
import { checkExecutorUpdate } from '../src/update.js'
import { loadExecutorToken, saveExecutorToken } from '../src/executor-token.js'

const logger = createRuntimeLogger('agent-kernel-executor')

type Args = {
  host?: string
  name?: string
  sandboxRoots: string[]
  token?: string
  invite?: string
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
      case '--invite':
      case '--id':
      case '--update-repo': {
        const value = inline ?? argv[++i]
        if (value === undefined) break
        if (key === '--host') out.host = value
        else if (key === '--name') out.name = value
        else if (key === '--sandbox-root') out.sandboxRoots.push(value)
        else if (key === '--token') out.token = value
        else if (key === '--invite') out.invite = value
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

/**
 * Acquire a single-instance lock at `~/.agent-kernel/executor.lock`. Fails
 * fast (no retry) if another executor process on the same user account is
 * already running. The lock is released automatically on process exit;
 * `proper-lockfile` also uses mtime-based stale detection so a crashed
 * executor's lock becomes reclaimable after 30 seconds.
 */
async function acquireLocalLock(
  logger: ReturnType<typeof createRuntimeLogger>,
): Promise<string> {
  const dir = join(homedir(), '.agent-kernel')
  mkdirSync(dir, { recursive: true })
  const lockPath = join(dir, 'executor.lock')
  // proper-lockfile locks a target file  -  write an empty sentinel first
  // so its existence check succeeds.
  if (!existsSync(lockPath)) {
    writeFileSync(lockPath, '', { flag: 'a', mode: 0o600 })
  }
  try {
    await lockfile.lock(lockPath, {
      stale: 30_000,
      retries: 0,
      realpath: false,
    })
    // Overwrite the sentinel with our PID + timestamp so a user can trace
    // stray locks. (proper-lockfile itself keeps a sibling `.lock`
    // directory; the payload of `lockPath` is just informational.)
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`)
    return lockPath
  } catch (err) {
    // Contention: read whoever's already holding the lock.
    let existingPid = '?'
    try {
      existingPid = readFileSync(lockPath, 'utf8').split('\n')[0]?.trim() ?? '?'
    } catch {
      // ignore
    }
    logger.error(
      {
        existingPid,
        lockPath,
        err: err instanceof Error ? err.message : String(err),
      },
      `another executor is already running on this machine (pid ${existingPid}). ` +
        `Stop it first, or if you're sure no executor is running, delete ${lockPath}.`,
    )
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const host = args.host ?? process.env.HOST_URL
  const name = args.name ?? process.env.WORKSPACE_NAME
  const envRoots = process.env.SANDBOX_ROOTS
    ? process.env.SANDBOX_ROOTS.split(':').filter((s) => s.length > 0)
    : []
  const sandboxRoots = args.sandboxRoots.length > 0 ? args.sandboxRoots : envRoots
  const invite = args.invite ?? process.env.EXECUTOR_INVITE
  const token = args.token ?? process.env.EXECUTOR_TOKEN ?? (invite ? undefined : loadExecutorToken())
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

  // Local single-instance lock. A single machine may only run one executor
  // at a time  -  otherwise two processes would race for the same workspaceId
  // and only one would end up bound on the host side (the other would be
  // rejected by the host's workspaceId arbitration, but the misleading
  // failure mode is worse than an early exit here).
  const lockPath = await acquireLocalLock(logger)
  process.on('exit', () => {
    // Best-effort release. proper-lockfile also survives crashes via mtime
    // staleness so we don't panic if this doesn't run.
    void lockfile.unlock(lockPath, { realpath: false }).catch(() => undefined)
  })

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
    ...(invite !== undefined ? { invite } : {}),
    ...(executorId !== undefined ? { executorId } : {}),
    onToken(nextToken) {
      saveExecutorToken(nextToken)
      logger.info('executor identity saved for future reconnects')
    },
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

  // Wait for a permanent error signal from the wire layer. This resolves
  // only if we've decided reconnection is hopeless  -  bad version, wrong
  // auth, host claimed our workspaceId, or socket.io ran out of retry
  // budget. Distinct exit codes let systemd / launchd distinguish "please
  // restart me" from "don't restart, fix the config".
  const failure = await handle.permanentError
  const exitCodeByReason: Record<string, number> = {
    workspace_id_conflict: 2,
    workspace_identity_mismatch: 2,
    version_incompatible: 3,
    auth_failed: 4,
    reconnect_exhausted: 5,
  }
  const code = exitCodeByReason[failure.code] ?? 1
  logger.error(
    { failure },
    `executor stopping  -  this is a permanent failure that will not self-heal. ` +
      `See message above for instructions.`,
  )
  process.exit(code)
}

main().catch((err) => {
  logger.error({ err }, 'fatal error')
  process.exit(1)
})
