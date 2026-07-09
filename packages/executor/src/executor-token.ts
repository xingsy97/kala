import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { EXECUTOR_PROFILE_ENV, executorProfileDir } from './workspace-id.js'

export const EXECUTOR_TOKEN_FILE_ENV = 'AGENT_KERNEL_EXECUTOR_TOKEN_FILE'

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
