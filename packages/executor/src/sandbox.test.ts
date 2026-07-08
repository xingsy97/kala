import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSandbox, SandboxError } from './sandbox.js'

// The sandbox returns *canonical* absolute paths (symlinks resolved, and on
// Windows 8.3 short names like `C:\Users\USER\ - ` expanded to their long
// form). `os.tmpdir()` can itself be an 8.3 path, so a raw `mkdtemp` result is
// not necessarily canonical. Run every temp dir through the same
// canonicalization the sandbox uses so assertions compare like with like on
// any TEMP configuration. On Linux/macOS this is a no-op.
function canonical(p: string): string {
  return realpathSync.native(p)
}

describe('sandbox', () => {
  let workspace: string
  let outside: string

  beforeEach(() => {
    workspace = canonical(mkdtempSync(join(tmpdir(), 'ak-sandbox-ws-')))
    outside = canonical(mkdtempSync(join(tmpdir(), 'ak-sandbox-out-')))
    writeFileSync(join(workspace, 'a.txt'), 'hi')
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub', 'b.txt'), 'sub')
    writeFileSync(join(outside, 'secret.txt'), 'nope')
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('accepts a file inside the workspace', async () => {
    const sb = createSandbox({ roots: [workspace] })
    const p = await sb.resolve(join(workspace, 'a.txt'))
    expect(p).toBe(join(workspace, 'a.txt'))
  })

  it('accepts a nested path', async () => {
    const sb = createSandbox({ roots: [workspace] })
    const p = await sb.resolve(join(workspace, 'sub', 'b.txt'))
    expect(p).toBe(join(workspace, 'sub', 'b.txt'))
  })

  it('rejects an absolute path outside the workspace', async () => {
    const sb = createSandbox({ roots: [workspace] })
    await expect(sb.resolve(join(outside, 'secret.txt'))).rejects.toBeInstanceOf(
      SandboxError,
    )
  })

  it('rejects a .. escape attempt', async () => {
    const sb = createSandbox({ roots: [workspace] })
    const escape = join(workspace, '..', 'not-in-ws.txt')
    await expect(sb.resolve(escape)).rejects.toBeInstanceOf(SandboxError)
  })

  it('rejects a symlink that points outside', async () => {
    const link = join(workspace, 'evil-link')
    symlinkSync(join(outside, 'secret.txt'), link)
    const sb = createSandbox({ roots: [workspace] })
    await expect(sb.resolve(link)).rejects.toBeInstanceOf(SandboxError)
  })

  it('allows a not-yet-existing file whose parent is inside the workspace', async () => {
    const sb = createSandbox({ roots: [workspace] })
    const newFile = join(workspace, 'sub', 'brand-new.txt')
    const p = await sb.resolve(newFile)
    expect(p).toBe(newFile)
  })

  it('rejects an empty path', async () => {
    const sb = createSandbox({ roots: [workspace] })
    await expect(sb.resolve('')).rejects.toBeInstanceOf(SandboxError)
  })

  it('supports multiple workspace roots', async () => {
    const alt = canonical(mkdtempSync(join(tmpdir(), 'ak-sandbox-alt-')))
    writeFileSync(join(alt, 'c.txt'), 'alt')
    try {
      const sb = createSandbox({ roots: [workspace, alt] })
      expect(await sb.resolve(join(workspace, 'a.txt'))).toBe(
        join(workspace, 'a.txt'),
      )
      expect(await sb.resolve(join(alt, 'c.txt'))).toBe(join(alt, 'c.txt'))
    } finally {
      rmSync(alt, { recursive: true, force: true })
    }
  })

  it('resolves relative paths against the first workspace root, not process.cwd()', async () => {
    const sb = createSandbox({ roots: [workspace] })
    // "." should be the workspace root itself.
    expect(await sb.resolve('.')).toBe(workspace)
    // "sub/b.txt" should join under the workspace.
    expect(await sb.resolve('sub/b.txt')).toBe(join(workspace, 'sub', 'b.txt'))
  })
})
