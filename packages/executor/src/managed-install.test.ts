import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { installManagedGeneration, managedInstallSourceExecutable } from './managed-install.js'

describe('installManagedGeneration', () => {
  it('uses the bundled script rather than the Node.js runtime for fallback installs', () => {
    expect(managedInstallSourceExecutable('/usr/bin/node', './release/agent-kernel-executor.cjs'))
      .toBe(join(process.cwd(), 'release', 'agent-kernel-executor.cjs'))
    expect(managedInstallSourceExecutable('/tmp/runlab-executor', '/tmp/ignored.cjs'))
      .toBe('/tmp/runlab-executor')
    expect(() => managedInstallSourceExecutable('/usr/bin/node', undefined))
      .toThrow('missing its script path')
  })

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

  it('repairs a generation polluted with the Node.js runtime by the legacy fallback installer', () => {
    const root = mkdtempSync(join(tmpdir(), 'runlab-managed-repair-'))
    const source = join(root, 'executor.cjs')
    const node = join(root, 'node')
    try {
      writeFileSync(source, 'executor script')
      writeFileSync(node, 'node runtime')
      const polluted = installManagedGeneration(node, join(root, 'managed'), '1.2.3')
      const repaired = installManagedGeneration(source, join(root, 'managed'), '1.2.3', node)
      expect(repaired.installed).toBe(true)
      expect(readFileSync(polluted.executable, 'utf8')).toBe('executor script')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
