import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { executorTokenPath, hashExecutorInviteRoute, loadExecutorRouteHint, loadExecutorToken, saveExecutorRouteHint, saveExecutorToken } from './executor-token.js'

describe('executor token persistence', () => {
  let dir: string | undefined

  afterEach(() => {
    delete process.env.KALA_EXECUTOR_TOKEN_FILE
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('returns undefined when no saved token exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'ak-token-'))
    expect(loadExecutorToken(join(dir, 'missing-token'))).toBeUndefined()
  })

  it('saves and loads the long-term executor token with private file mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'ak-token-'))
    const path = join(dir, 'nested', 'executor-token')

    saveExecutorToken('ak_exec_test', path)

    expect(loadExecutorToken(path)).toBe('ak_exec_test')
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  it('persists a private, non-redeemable route hint separately from the device credential', () => {
    dir = mkdtempSync(join(tmpdir(), 'ak-route-'))
    process.env.KALA_EXECUTOR_TOKEN_FILE = join(dir, 'executor-token')
    const invite = 'synthetic-invite-for-test-only'
    saveExecutorRouteHint(invite)
    const hint = loadExecutorRouteHint()
    expect(hint).toBe(hashExecutorInviteRoute(invite))
    expect(hint).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(readFileSync(join(dir, 'executor-route-hint'), 'utf8')).not.toContain(invite)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'executor-route-hint')).mode & 0o777).toBe(0o600)
  })

  it('uses an isolated token path for a named profile', () => {
    expect(executorTokenPath('dev')).toMatch(/\.kala\/profiles\/dev\/executor-token$/)
    expect(executorTokenPath('default')).toMatch(/\.kala\/executor-token$/)
  })
})
