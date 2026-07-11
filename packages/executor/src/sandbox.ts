/**
 * Machine sandbox: canonicalize a caller-supplied path and  -  if the operator
 * configured `--sandbox-root` whitelist(s)  -  verify it lives inside one.
 *
 * When `roots` is empty, the executor trusts the whole filesystem (a design
 * choice: the executor runs on the operator's machine under their user, so
 * the OS's own permission model is enforcement enough by default). Operators
 * who want a stricter jail pass one or more `--sandbox-root` paths.
 *
 * The whitelist check MUST happen after symlink resolution  -  a symlink
 * dangling outside the whitelist would otherwise be a data-leak vector.
 */

import { realpath } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

export type ResolveOptions = {
  /**
   * Base directory for resolving relative `path` inputs. Overrides the
   * default (`roots[0]` or `process.cwd()`). Absolute inputs ignore this.
   * Set by the executor client from the per-call `cwd` on `tool:call`, so
   * that `ls "."` behaves consistently with `bash pwd` under the same
   * `state.cwd`.
   */
  readonly cwd?: string
}

export type Sandbox = {
  /**
   * Configured sandbox roots. Empty array means "no path restriction"  -  the
   * `resolve()` call still canonicalises the input but does not reject it
   * for being outside any root.
   */
  readonly roots: readonly string[]
  /**
   * Resolve a caller-supplied path to an absolute canonical path. If
   * `roots` is non-empty, the resolved path must live under one of them or
   * `EACCES: outside sandbox` is thrown. Non-existent leaves are allowed as
   * long as their nearest existing ancestor is inside the whitelist
   * (needed for write/edit tools that create new files). Relative inputs
   * are resolved against `opts.cwd` if supplied, else against `roots[0]`
   * if configured, else against `process.cwd()`.
   */
  resolve(path: string, opts?: ResolveOptions): Promise<string>
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

/**
 * Synchronous canonicalizer for the configured roots. Roots are resolved once
 * at construction, so a sync `realpath` keeps `createSandbox` synchronous.
 *
 * Roots MUST be canonicalized the same way inputs are, and here that means
 * `realpathSync.native`  -  NOT the plain `realpathSync`. On Windows the two
 * sync variants disagree with the async `realpath` used for inputs: given a
 * path carrying an 8.3 short name (`C:\Users\USERNAM~1\ - `, as `os.tmpdir()`
 * can yield), plain `realpathSync` leaves the alias intact while both
 * `realpathSync.native` and the async `realpath` expand it to the long name
 * (`C:\Users\username\ - `). If the root stayed short while inputs came back
 * long, `canonical.startsWith(root + sep)` would be false for paths genuinely
 * inside the root  -  a false EACCES (and, conversely, a short-form root would
 * never match its own realpath'd contents). Using `.native` keeps both sides
 * on the long form. Falls back to the resolved path if the root does not yet
 * exist.
 */
function canonicalizeRootSync(p: string): string {
  if (existsSync(p)) return realpathSync.native(p)
  let cur = p
  const parts: string[] = []
  while (true) {
    if (existsSync(cur)) {
      const base = realpathSync.native(cur)
      return resolve(base, ...parts.reverse())
    }
    const parent = dirname(cur)
    if (parent === cur) return p
    parts.push(cur.slice(parent.length + 1))
    cur = parent
  }
}

export function createSandbox(options: SandboxOptions): Sandbox {
  const canonicalRoots = options.roots.map((r) => {
    if (!isAbsolute(r)) {
      throw new Error(`sandbox root must be absolute: ${r}`)
    }
    return canonicalizeRootSync(resolve(r))
  })

  return {
    roots: canonicalRoots,
    async resolve(input: string, opts?: ResolveOptions) {
      if (typeof input !== 'string' || input.length === 0) {
        throw new SandboxError('EACCES: empty path', 'EACCES')
      }
      const base = opts?.cwd ?? canonicalRoots[0] ?? process.cwd()
      const absolute = isAbsolute(input) ? input : resolve(base, input)
      const canonical = await canonicalizeMaybeMissing(absolute)
      if (canonicalRoots.length === 0) return canonical
      for (const root of canonicalRoots) {
        if (canonical === root) return canonical
        if (canonical.startsWith(root + sep)) return canonical
      }
      throw new SandboxError(
        `EACCES: outside sandbox: ${input}`,
        'EACCES',
      )
    },
  }
}
