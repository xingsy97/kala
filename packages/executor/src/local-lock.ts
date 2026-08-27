import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import lockfile from 'proper-lockfile'

type LockLogger = {
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

export async function acquireExecutorLock(
  profileDir: string,
  logger: LockLogger,
  options: {
    pid?: number
    isProcessAlive?: (pid: number) => boolean
    orphanCheckDelayMs?: number
  } = {},
): Promise<string> {
  const pid = options.pid ?? process.pid
  const isProcessAlive = options.isProcessAlive ?? processIsAlive
  const orphanCheckDelayMs = options.orphanCheckDelayMs ?? 100
  mkdirSync(profileDir, { recursive: true })
  const lockPath = join(profileDir, 'executor.lock')
  if (!existsSync(lockPath)) writeFileSync(lockPath, '', { flag: 'a', mode: 0o600 })

  await reclaimOrphanedLock(lockPath, logger, isProcessAlive, orphanCheckDelayMs)
  try {
    await lockfile.lock(lockPath, {
      stale: 30_000,
      retries: 0,
      realpath: false,
    })
    writeFileSync(lockPath, `${pid}\n${new Date().toISOString()}\n`)
    return lockPath
  } catch (error) {
    const existingPid = readLockPid(lockPath)
    logger.error(
      {
        existingPid: existingPid ?? '?',
        lockPath,
        err: error instanceof Error ? error.message : String(error),
      },
      `another executor is already running on this machine (pid ${existingPid ?? '?'}). Stop it before starting another Executor.`,
    )
    throw error
  }
}

async function reclaimOrphanedLock(
  lockPath: string,
  logger: LockLogger,
  isProcessAlive: (pid: number) => boolean,
  delayMs: number,
): Promise<void> {
  const properLockPath = `${lockPath}.lock`
  if (!existsSync(properLockPath)) return
  const firstPid = readLockPid(lockPath)
  if (firstPid === undefined || isProcessAlive(firstPid)) return
  const firstMtime = statSync(properLockPath).mtimeMs
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
  if (!existsSync(properLockPath)) return
  const secondPid = readLockPid(lockPath)
  const secondMtime = statSync(properLockPath).mtimeMs
  if (
    secondPid !== firstPid
    || secondMtime !== firstMtime
    || (secondPid !== undefined && isProcessAlive(secondPid))
  ) {
    return
  }
  rmSync(properLockPath, { recursive: true, force: true })
  logger.warn(
    { lockPath, orphanedPid: firstPid },
    'removed an orphaned Executor lock whose owner process no longer exists',
  )
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(lockPath, 'utf8').split('\n')[0]?.trim() ?? '', 10)
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
