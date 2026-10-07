import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  packageWindowsNodePtyCompanion,
  WINDOWS_EXECUTOR_TARGET,
  WINDOWS_NODE_PTY_FILES,
  windowsNodePtyCompanionAssetName,
} from './windows-executor-packager.mjs'

function fakeWindowsX64Pe(marker) {
  const bytes = Buffer.alloc(128)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x40, 0x3c)
  bytes.write('PE\0\0', 0x40, 'binary')
  bytes.writeUInt16LE(0x8664, 0x44)
  bytes[0x46] = marker
  return bytes
}

test('packages a self-describing Windows x64 node-pty runtime with per-file digests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kala-windows-packager-test-'))
  try {
    const nodePtyRoot = join(dir, 'node-pty')
    const prebuild = join(nodePtyRoot, 'prebuilds', WINDOWS_EXECUTOR_TARGET)
    mkdirSync(prebuild, { recursive: true })
    writeFileSync(join(nodePtyRoot, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }))
    for (const [index, name] of WINDOWS_NODE_PTY_FILES.entries()) {
      writeFileSync(join(prebuild, name), fakeWindowsX64Pe(index))
    }

    const archive = join(dir, windowsNodePtyCompanionAssetName())
    const manifest = packageWindowsNodePtyCompanion({ nodePtyRoot, outputPath: archive })
    assert.equal(manifest.target, 'win32-x64')
    assert.equal(manifest.nodePtyVersion, '1.1.0')
    assert.deepEqual(manifest.files.map((file) => file.path), WINDOWS_NODE_PTY_FILES.map((name) => `prebuilds/win32-x64/${name}`))
    for (const [index, file] of manifest.files.entries()) {
      const bytes = fakeWindowsX64Pe(index)
      assert.equal(file.bytes, bytes.length)
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
    }

    const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    const entries = listed.stdout.trim().split('\n').sort()
    assert.deepEqual(entries, ['node-pty-companion.json', 'win32-x64/', ...WINDOWS_NODE_PTY_FILES.map((name) => `win32-x64/${name}`)].sort())
    const embedded = spawnSync('tar', ['-xOzf', archive, 'node-pty-companion.json'], { encoding: 'utf8' })
    assert.equal(embedded.status, 0, embedded.stderr)
    assert.deepEqual(JSON.parse(embedded.stdout), manifest)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails closed for missing, non-PE, or unsupported companion inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kala-windows-packager-invalid-test-'))
  try {
    const prebuild = join(dir, 'prebuilds', WINDOWS_EXECUTOR_TARGET)
    mkdirSync(prebuild, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }))
    assert.throws(() => packageWindowsNodePtyCompanion({ nodePtyRoot: dir, outputPath: join(dir, 'missing.tar.gz') }), /missing conpty\.node/)
    for (const name of WINDOWS_NODE_PTY_FILES) writeFileSync(join(prebuild, name), Buffer.from('not-a-pe'))
    assert.throws(() => packageWindowsNodePtyCompanion({ nodePtyRoot: dir, outputPath: join(dir, 'invalid.tar.gz') }), /not a Windows x64 PE binary/)
    assert.throws(() => windowsNodePtyCompanionAssetName('win32-arm64'), /unsupported Windows Executor target/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
