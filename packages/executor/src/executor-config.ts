import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'

export type ExecutorRuntimeConfig = {
  version: 1
  host: string
  name?: string
  profile?: string
  sandboxRoots: string[]
  credentialFile: string
  installationId?: string
  installationSource?: 'dashboard-native' | 'package-manager' | 'container' | 'legacy-cjs'
}

export function readExecutorRuntimeConfig(path: string): ExecutorRuntimeConfig {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Executor config must be a regular file')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let raw: string
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Executor config changed while opening')
    raw = readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
  const value = JSON.parse(raw) as Partial<ExecutorRuntimeConfig>
  if (value.version !== 1 || typeof value.host !== 'string' || !/^https?:\/\//u.test(value.host) ||
      typeof value.credentialFile !== 'string' || !Array.isArray(value.sandboxRoots) ||
      value.sandboxRoots.some((root) => typeof root !== 'string' || !root)) throw new Error('Invalid Executor config')
  return value as ExecutorRuntimeConfig
}

export function readExecutorCredential(path: string): string {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Executor credential must be a regular file')
  if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) throw new Error('Executor credential permissions must be 0600')
  const value = readFileSync(path, 'utf8').trim()
  if (!value.startsWith('ak_exec_') && !value.startsWith('ak_invite_')) throw new Error('Invalid Executor credential')
  return value
}
