import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readExecutorRuntimeConfig } from './executor-config.js'

describe('Executor runtime route hint', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  function config(routeHint: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'kala-executor-config-'))
    dirs.push(dir)
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({
      version: 1,
      host: 'https://tenant.example',
      sandboxRoots: ['C:\\workspace'],
      credentialFile: 'C:\\ProgramData\\Kala\\Executor\\credential',
      privilegeMode: 'privileged',
      routeHint,
    }), { mode: 0o600 })
    return path
  }

  it('accepts only a non-secret SHA-256 base64url tenant route hint', () => {
    const hint = 'A'.repeat(43)
    expect(readExecutorRuntimeConfig(config(hint)).routeHint).toBe(hint)
    expect(() => readExecutorRuntimeConfig(config('ak_invite_secret'))).toThrow('Invalid Executor config')
  })
})
