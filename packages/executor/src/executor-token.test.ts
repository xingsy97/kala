import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadExecutorToken, saveExecutorToken } from './executor-token.js'

describe('executor token persistence', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('returns undefined when no saved token exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'ak-token-'))
    expect(loadExecutorToken(join(dir, 'missing-token'))).toBeUndefined()
  })

  it('saves and loads the long-term executor token with private file mode', () => {
    dir = mkdtempSync(join(tmpdir(), 'ak-token-'))
    const path = join(dir, 'nested', 'executor-token')

    saveExecutorToken('ak_exec_test', path)

    expect(loadExecutorToken(path)).toBe('ak_exec_test')
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })
})
