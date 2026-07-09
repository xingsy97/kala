import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const EXECUTOR_TOKEN_FILE_ENV = 'AGENT_KERNEL_EXECUTOR_TOKEN_FILE'

export function executorTokenPath(): string {
  const override = process.env[EXECUTOR_TOKEN_FILE_ENV]
  if (override && override.length > 0) return override
  return join(homedir(), '.agent-kernel', 'executor-token')
}

export function loadExecutorToken(pathOverride?: string): string | undefined {
  const path = pathOverride ?? executorTokenPath()
  if (!existsSync(path)) return undefined
  const token = readFileSync(path, 'utf8').trim()
  return token.length > 0 ? token : undefined
}

export function saveExecutorToken(token: string, pathOverride?: string): void {
  const path = pathOverride ?? executorTokenPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
}
