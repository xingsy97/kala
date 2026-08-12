import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'

import type { ServiceMode } from './cli-args.js'

export type InstallerSession = {
  version: 1
  mode: ServiceMode
  executable: string
  host: string
  profile?: string
  name?: string
  sandboxRoots: string[]
  credential: { token?: string; invite?: string }
  installationId?: string
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`Invalid installer session ${name}`)
  }
  return value
}

/** Reads a private, regular JSON session file without following symlinks. */
export function readInstallerSession(path: string): InstallerSession {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Installer session must be a regular file')
  if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) {
    throw new Error('Installer session permissions must be 0600')
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let raw: string
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Installer session changed while opening')
    }
    raw = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }

  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Installer session is not valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid installer session')
  const input = value as Record<string, unknown>
  if (input.version !== 1) throw new Error('Unsupported installer session version')
  if (input.mode !== 'system' && input.mode !== 'user') throw new Error('Invalid installer session mode')
  const executable = optionalString(input.executable, 'executable')
  const host = optionalString(input.host, 'host')
  if (!executable || !host) throw new Error('Installer session requires executable and host')
  if (!Array.isArray(input.sandboxRoots) || input.sandboxRoots.some((item) => typeof item !== 'string')) {
    throw new Error('Invalid installer session sandboxRoots')
  }
  const credentialInput = input.credential
  if (!credentialInput || typeof credentialInput !== 'object' || Array.isArray(credentialInput)) {
    throw new Error('Installer session requires credential')
  }
  const credentialObject = credentialInput as Record<string, unknown>
  const token = optionalString(credentialObject.token, 'credential.token')
  const invite = optionalString(credentialObject.invite, 'credential.invite')
  if ((token ? 1 : 0) + (invite ? 1 : 0) !== 1) throw new Error('Installer session requires exactly one credential')

  return {
    version: 1,
    mode: input.mode,
    executable,
    host,
    ...(optionalString(input.profile, 'profile') ? { profile: input.profile as string } : {}),
    ...(optionalString(input.name, 'name') ? { name: input.name as string } : {}),
    sandboxRoots: [...input.sandboxRoots] as string[],
    credential: { ...(token ? { token } : {}), ...(invite ? { invite } : {}) },
    ...(optionalString(input.installationId, 'installationId') ? { installationId: input.installationId as string } : {}),
  }
}
