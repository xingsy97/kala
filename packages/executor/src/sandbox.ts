/**
 * Workspace sandbox: canonicalize a caller-supplied path and verify it lives
 * under one of the whitelisted workspace roots.
 *
 * The check MUST happen after symlink resolution  -  a symlink that dangles
 * outside the workspace would otherwise be a data-leak vector.
 */

import { realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

export type Sandbox = {
  readonly roots: readonly string[]
  /**
   * Resolve a caller-supplied path to an absolute canonical path inside the
   * workspace. Throws `EACCES: outside workspace` if the target escapes the
   * whitelist. Non-existent leaves are allowed as long as their nearest
   * existing ancestor is inside the workspace (needed for write/edit tools
   * that create new files).
   */
  resolve(path: string): Promise<string>
}

export type SandboxOptions = {
  roots: readonly string[]
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}

async function canonicalizeMaybeMissing(p: string): Promise<string> {
  if (existsSync(p)) return await realpath(p)
  let cur = p
  const parts: string[] = []
  while (true) {
    if (existsSync(cur)) {
      const base = await realpath(cur)
      return resolve(base, ...parts.reverse())
    }
    const parent = dirname(cur)
    if (parent === cur) return p
    parts.push(cur.slice(parent.length + 1))
    cur = parent
  }
}

export function createSandbox(options: SandboxOptions): Sandbox {
  if (options.roots.length === 0) {
    throw new Error('sandbox requires at least one workspace root')
  }
  const canonicalRoots = options.roots.map((r) => {
    if (!isAbsolute(r)) {
      throw new Error(`workspace root must be absolute: ${r}`)
    }
    return resolve(r)
  })

  return {
    roots: canonicalRoots,
    async resolve(input: string) {
      if (typeof input !== 'string' || input.length === 0) {
        throw new SandboxError('EACCES: empty path', 'EACCES')
      }
      const absolute = isAbsolute(input)
        ? input
        : resolve(canonicalRoots[0]!, input)
      const canonical = await canonicalizeMaybeMissing(absolute)
      for (const root of canonicalRoots) {
        if (canonical === root) return canonical
        if (canonical.startsWith(root + sep)) return canonical
      }
      throw new SandboxError(
        `EACCES: outside workspace: ${input}`,
        'EACCES',
      )
    },
  }
}
