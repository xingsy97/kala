import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globTool } from './glob.js'
import { makeCtx } from './_test-helpers.js'

describe('glob', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ak-glob-'))
    writeFileSync(join(root, 'a.ts'), '')
    writeFileSync(join(root, 'b.ts'), '')
    writeFileSync(join(root, 'c.js'), '')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'nested.ts'), '')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('matches by extension', async () => {
    const out = await globTool.run(
      { pattern: '**/*.ts', cwd: root },
      makeCtx(root),
    )
    const paths = out.split('\n').sort()
    expect(paths).toEqual([
      join(root, 'a.ts'),
      join(root, 'b.ts'),
      join(root, 'sub', 'nested.ts'),
    ].sort())
  })

  it('returns empty for zero matches', async () => {
    const out = await globTool.run(
      { pattern: '**/*.py', cwd: root },
      makeCtx(root),
    )
    expect(out).toBe('')
  })

  it('defaults cwd to the first workspace root', async () => {
    const out = await globTool.run({ pattern: '*.ts' }, makeCtx(root))
    expect(out.split('\n').sort()).toEqual(
      [join(root, 'a.ts'), join(root, 'b.ts')].sort(),
    )
  })
})
