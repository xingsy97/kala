import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSandbox } from '../sandbox.js'
import type { ToolContext } from './registry.js'

/**
 * Create a temp workspace and return its *canonical* path.
 *
 * The fs tools resolve caller paths through the sandbox, which canonicalizes
 * them (symlinks resolved, and on Windows 8.3 short names like
 * `C:\Users\USER\ - ` expanded to their long form). `os.tmpdir()` can itself
 * be an 8.3 path, so a raw `mkdtempSync` result is not canonical and won't
 * match tool output. Canonicalizing here  -  the same way the sandbox does  - 
 * keeps test assertions comparing like with like on any TEMP configuration.
 * A no-op on Linux/macOS.
 */
export function makeTempWorkspace(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

/**
 * Fold a filesystem path to a comparable canonical form, papering over the
 * three shapes the same location can take on Windows: native backslash
 * (`C:\a\b`), forward-slash (`C:/a/b`), and Git-Bash / MSYS drive syntax
 * (`/c/a/b`). Lowercases the drive letter and switches to forward slashes.
 * On POSIX this is effectively just the identity (already `/a/b`). Use it to
 * assert that a shell landed in the expected directory without pinning the
 * exact byte form of the shell's own `pwd` output.
 */
export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/')
  // `/c/Users/...` (MSYS) -> `c:/Users/...`
  const msys = /^\/([a-zA-Z])\//.exec(s)
  if (msys) s = `${msys[1]!.toLowerCase()}:/${s.slice(3)}`
  // `C:/Users/...` -> `c:/Users/...`
  s = s.replace(/^([a-zA-Z]):\//, (_m, d: string) => `${d.toLowerCase()}:/`)
  return s
}

export function makeCtx(root: string, signal?: AbortSignal): ToolContext {
  return {
    sandbox: createSandbox({ roots: [root] }),
    signal: signal ?? new AbortController().signal,
  }
}

export function makeCtxWithCwd(
  root: string,
  cwd: string,
  signal?: AbortSignal,
): ToolContext {
  return {
    sandbox: createSandbox({ roots: [root] }),
    cwd,
    signal: signal ?? new AbortController().signal,
  }
}
