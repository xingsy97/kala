import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { grepTool } from './grep.js'
import { makeCtx } from './_test-helpers.js'

describe('grep', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-grep-'))
    writeFileSync(join(root, 'a.ts'), 'hello world\nsecond hello')
    writeFileSync(join(root, 'b.ts'), 'nothing here')
    writeFileSync(join(root, 'c.js'), 'hello js')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('default output_mode is files_with_matches', async () => {
    const out = await grepTool.run(
      { pattern: 'hello' },
      makeCtx(root),
    )
    const paths = out.split('\n').sort()
    expect(paths).toEqual([join(root, 'a.ts'), join(root, 'c.js')].sort())
  })

  it('count mode reports per-file counts', async () => {
    const out = await grepTool.run(
      { pattern: 'hello', output_mode: 'count' },
      makeCtx(root),
    )
    const lines = out.split('\n').sort()
    expect(lines).toContain(`${join(root, 'a.ts')}:2`)
    expect(lines).toContain(`${join(root, 'c.js')}:1`)
  })

  it('content mode returns path:line:text', async () => {
    const out = await grepTool.run(
      { pattern: 'hello', output_mode: 'content', glob: '*.ts' },
      makeCtx(root),
    )
    expect(out).toContain(`${join(root, 'a.ts')}:1:hello world`)
    expect(out).toContain(`${join(root, 'a.ts')}:2:second hello`)
    expect(out).not.toContain('c.js')
  })

  it('throws EINVAL on bad regex', async () => {
    await expect(
      grepTool.run({ pattern: '(' }, makeCtx(root)),
    ).rejects.toThrow(/EINVAL/)
  })
})
