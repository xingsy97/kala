import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { copyOverflowSession, deleteOverflowSession } from './fs-handlers.js'
import { createSandbox } from './sandbox.js'

describe('overflow filesystem lifecycle handlers', () => {
  let root: string

  beforeEach(() => {
    root = join(tmpdir(), `ak-overflow-fs-${randomUUID()}`)
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('copies overflow files between session directories', async () => {
    const source = join(root, '.agent-kernel', 'overflow', 'sess-a')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'call-1.txt'), 'full output', 'utf8')

    const result = await copyOverflowSession(
      { requestId: 'r1', sourceSessionId: 'sess-a', targetSessionId: 'sess-b' },
      createSandbox({ roots: [root] }),
    )

    expect(result).toMatchObject({ copied: true })
    expect(readFileSync(join(root, '.agent-kernel', 'overflow', 'sess-b', 'call-1.txt'), 'utf8')).toBe('full output')
  })

  it('deletes an overflow session directory', async () => {
    const target = join(root, '.agent-kernel', 'overflow', 'sess-a')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'call-1.txt'), 'full output', 'utf8')

    const result = await deleteOverflowSession(
      { requestId: 'r1', sessionId: 'sess-a' },
      createSandbox({ roots: [root] }),
    )

    expect(result).toMatchObject({ deleted: true })
    expect(existsSync(target)).toBe(false)
  })
})
