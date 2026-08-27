import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { installManagedGeneration } from './managed-install.js'

describe('installManagedGeneration', () => {
  it('publishes an immutable generation and reuses it on repeated installs', () => {
    const root = mkdtempSync(join(tmpdir(), 'runlab-managed-install-'))
    const source = join(root, 'source')
    try {
      writeFileSync(source, 'first')
      const first = installManagedGeneration(source, join(root, 'managed'), '1.2.3')
      expect(first.installed).toBe(true)
      expect(readFileSync(first.executable, 'utf8')).toBe('first')

      writeFileSync(source, 'replacement')
      const repeated = installManagedGeneration(source, join(root, 'managed'), '1.2.3')
      expect(repeated.installed).toBe(false)
      expect(readFileSync(repeated.executable, 'utf8')).toBe('first')
      expect(readFileSync(join(root, 'managed', 'current', 'runlab-executor'), 'utf8')).toBe('first')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
