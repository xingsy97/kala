import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { EXECUTOR_PROFILE_ENV, executorProfileDir } from './workspace-id.js'

export const EXECUTOR_TOKEN_FILE_ENV = 'KALA_EXECUTOR_TOKEN_FILE'

export function executorTokenPath(profile?: string): string {
  const override = process.env[EXECUTOR_TOKEN_FILE_ENV]
  if (override && override.length > 0) return override
  return join(executorProfileDir(profile ?? process.env[EXECUTOR_PROFILE_ENV]), 'executor-token')
}

export function loadExecutorToken(pathOverride?: string, profile?: string): string | undefined {
  const path = pathOverride ?? executorTokenPath(profile)
  if (!existsSync(path)) return undefined
  const token = readFileSync(path, 'utf8').trim()
  return token.length > 0 ? token : undefined
}

export function saveExecutorToken(token: string, pathOverride?: string, profile?: string): void {
  const path = pathOverride ?? executorTokenPath(profile)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** Non-redeemable tenant routing hint for an enrolled Executor's next upgrade. */
export function hashExecutorInviteRoute(invite: string): string {
  return createHash('sha256').update(invite).digest('base64url')
}

export function loadExecutorRouteHint(profile?: string): string | undefined {
  const path = join(dirname(executorTokenPath(profile)), 'executor-route-hint')
  if (!existsSync(path)) return undefined
  const hint = readFileSync(path, 'utf8').trim()
  return /^[A-Za-z0-9_-]{43}$/u.test(hint) ? hint : undefined
}

export function saveExecutorRouteHint(invite: string, profile?: string): void {
  const path = join(dirname(executorTokenPath(profile)), 'executor-route-hint')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${hashExecutorInviteRoute(invite)}\n`, { encoding: 'utf8', mode: 0o600 })
}
