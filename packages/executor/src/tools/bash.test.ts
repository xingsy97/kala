import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bashTool } from './bash.js'
import { makeCtx } from './_test-helpers.js'

describe('bash', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-bash-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('runs a command and returns stdout + exit code', async () => {
    const out = await bashTool.run(
      { command: 'echo hello' },
      makeCtx(root),
    )
    expect(out).toContain('hello')
    expect(out).toContain('--- exit code: 0')
  })

  it('captures non-zero exit codes without ok:false semantics', async () => {
    const out = await bashTool.run(
      { command: 'sh -c "exit 3"' },
      makeCtx(root),
    )
    expect(out).toContain('--- exit code: 3')
  })

  it('honours timeoutMs by killing the process', async () => {
    const out = await bashTool.run(
      { command: 'sleep 5', timeoutMs: 200 },
      makeCtx(root),
    )
    expect(out).toContain('killed after 200ms (timeout)')
  })

  it('rejects cwd outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ak-bash-out-'))
    try {
      await expect(
        bashTool.run({ command: 'true', cwd: outside }, makeCtx(root)),
      ).rejects.toThrow(/EACCES/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('throws EINVAL on an empty command', async () => {
    await expect(
      bashTool.run({ command: '  ' }, makeCtx(root)),
    ).rejects.toThrow(/EINVAL/)
  })

  it('short-circuits when the signal is already aborted (no hang, no spawn)', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const start = Date.now()
    const out = await bashTool.run(
      { command: 'sleep 30' },
      makeCtx(root, ctrl.signal),
    )
    expect(Date.now() - start).toBeLessThan(200)
    expect(out).toContain('aborted before spawn')
    expect(out).toContain('--- exit code: -1')
  })

  it('reports mid-run abort as a status marker instead of hanging', async () => {
    const ctrl = new AbortController()
    const promise = bashTool.run(
      { command: 'sleep 5', timeoutMs: 10_000 },
      makeCtx(root, ctrl.signal),
    )
    // Give the process a moment to actually start, then abort.
    await new Promise((r) => setTimeout(r, 50))
    ctrl.abort()
    const out = await promise
    expect(out).toContain('--- aborted')
    // Should not have been treated as a timeout kill.
    expect(out).not.toContain('(timeout)')
  })

  it('resolves with a spawn-failure marker when the child errors', async () => {
    // Point cwd inside the workspace, but delete it after resolve() so spawn
    // trips ENOENT asynchronously. This is the exact class of failure the
    // old code silently swallowed (child.on('error') was never wired).
    const doomed = mkdtempSync(join(root, 'doomed-'))
    rmSync(doomed, { recursive: true, force: true })
    const out = await bashTool.run(
      { command: 'echo hi', cwd: doomed },
      makeCtx(root),
    )
    expect(out).toContain('spawn failed')
    expect(out).toContain('--- exit code: -1')
  })
})
