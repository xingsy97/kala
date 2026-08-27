import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import lockfile from 'proper-lockfile'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { acquireExecutorLock } from './local-lock.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('acquireExecutorLock', () => {
  it('reclaims a residual lock when its recorded process no longer exists', async () => {
    const profileDir = temporaryProfile()
    const lockPath = seedLock(profileDir, '999999')
    const logger = testLogger()

    const acquired = await acquireExecutorLock(profileDir, logger, {
      pid: process.pid,
      isProcessAlive: () => false,
      orphanCheckDelayMs: 0,
    })

    expect(acquired).toBe(lockPath)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orphanedPid: 999999 }),
      expect.stringContaining('orphaned Executor lock'),
    )
    await lockfile.unlock(lockPath, { realpath: false })
  })

  it('keeps a lock owned by a live process', async () => {
    const profileDir = temporaryProfile()
    seedLock(profileDir, '42')
    const logger = testLogger()

    await expect(acquireExecutorLock(profileDir, logger, {
      isProcessAlive: (pid) => pid === 42,
      orphanCheckDelayMs: 0,
    })).rejects.toThrow()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('fails closed when the lock owner metadata is malformed', async () => {
    const profileDir = temporaryProfile()
    seedLock(profileDir, 'not-a-pid')

    await expect(acquireExecutorLock(profileDir, testLogger(), {
      isProcessAlive: () => false,
      orphanCheckDelayMs: 0,
    })).rejects.toThrow()
  })

  it('allows only one concurrent owner', async () => {
    const profileDir = temporaryProfile()
    const logger = testLogger()
    const first = await acquireExecutorLock(profileDir, logger, { orphanCheckDelayMs: 0 })

    await expect(acquireExecutorLock(profileDir, logger, { orphanCheckDelayMs: 0 })).rejects.toThrow()
    await lockfile.unlock(first, { realpath: false })
  })

  it('isolates locks by Executor profile', async () => {
    const root = temporaryProfile()
    const first = await acquireExecutorLock(join(root, 'profile-a'), testLogger(), { orphanCheckDelayMs: 0 })
    const second = await acquireExecutorLock(join(root, 'profile-b'), testLogger(), { orphanCheckDelayMs: 0 })

    expect(existsSync(`${first}.lock`)).toBe(true)
    expect(existsSync(`${second}.lock`)).toBe(true)
    await Promise.all([
      lockfile.unlock(first, { realpath: false }),
      lockfile.unlock(second, { realpath: false }),
    ])
  })
})

function temporaryProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-runlab-lock-'))
  roots.push(root)
  return root
}

function seedLock(profileDir: string, owner: string): string {
  mkdirSync(profileDir, { recursive: true })
  const lockPath = join(profileDir, 'executor.lock')
  writeFileSync(lockPath, `${owner}\n2026-01-01T00:00:00.000Z\n`)
  mkdirSync(`${lockPath}.lock`)
  return lockPath
}

function testLogger(): { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn() }
}
