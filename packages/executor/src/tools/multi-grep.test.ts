import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSandbox } from '../sandbox.js'
import { multiGrepTool } from './multi-grep.js'

let root: string
let ctx: Parameters<typeof multiGrepTool.run>[1]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'multi-grep-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/a.ts'), 'alpha\nbeta\n你好 alpha\n')
  writeFileSync(join(root, 'src/b.ts'), 'beta\ngamma\n')
  ctx = { sessionId: 's', callId: 'c', sandbox: createSandbox({ roots: [root] }), signal: new AbortController().signal, cwd: root }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('multi_grep', () => {
  it('runs ordered searches with mixed output modes', async () => {
    const out = await multiGrepTool.run({ searches: [
      { pattern: 'alpha', path: 'src', output_mode: 'content' },
      { pattern: 'beta', path: 'src', output_mode: 'count' },
    ] }, ctx)
    expect(out.indexOf('search[0]')).toBeLessThan(out.indexOf('search[1]'))
    expect(out).toContain(':1:alpha')
    expect(out).toMatch(/a\.ts:1/)
  })

  it('keeps an empty section for no matches', async () => {
    const out = await multiGrepTool.run({ searches: [{ pattern: 'missing', path: 'src' }] }, ctx)
    expect(out).toBe('===== search[0] =====\n')
  })

  it.each([
    [{}, /searches/],
    [{ searches: [] }, /must not be empty/],
    [{ searches: Array.from({ length: 21 }, () => ({ pattern: 'x' })) }, /at most 20/],
    [{ searches: [{ pattern: '[' }] }, /invalid regex/],
  ])('rejects invalid input %#', async (input, message) => {
    await expect(multiGrepTool.run(input as never, ctx)).rejects.toThrow(message)
  })

  it('enforces a UTF-8-safe global byte budget', async () => {
    const out = await multiGrepTool.run({ searches: [{ pattern: '.', path: 'src/a.ts', output_mode: 'content' }, { pattern: 'beta', path: 'src' }], max_bytes: 110 }, ctx)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(110)
    expect(out).not.toContain('�')
    expect(out).toContain('truncated')
  })

  it('honors cancellation before execution', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(multiGrepTool.run({ searches: [{ pattern: 'alpha' }] }, { ...ctx, signal: controller.signal })).rejects.toThrow(/ECANCELED/)
  })
})
