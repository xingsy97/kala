import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  packageWindowsNodePtyCompanion,
  verifyWindowsNodePtyCompanion,
  WINDOWS_EXECUTOR_TARGET,
  WINDOWS_NODE_PTY_BINARY_FILES,
  WINDOWS_NODE_PTY_FILES,
  WINDOWS_NODE_PTY_JS_FILES,
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

function createNodePtyFixture(root) {
  const bytesByRuntimePath = new Map()
  mkdirSync(join(root, 'prebuilds', WINDOWS_EXECUTOR_TARGET), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }))
  for (const [index, name] of WINDOWS_NODE_PTY_BINARY_FILES.entries()) {
    const bytes = fakeWindowsX64Pe(index)
    writeFileSync(join(root, 'prebuilds', WINDOWS_EXECUTOR_TARGET, name), bytes)
    bytesByRuntimePath.set(`prebuilds/${WINDOWS_EXECUTOR_TARGET}/${name}`, bytes)
  }
  for (const [index, relative] of WINDOWS_NODE_PTY_JS_FILES.entries()) {
    const bytes = Buffer.from(`"use strict"; module.exports = ${index};\n`)
    const path = join(root, 'lib', ...relative.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, bytes)
    bytesByRuntimePath.set(relative, bytes)
  }
  return bytesByRuntimePath
}

test('packages a self-describing Windows x64 node-pty runtime with worker JavaScript and per-file digests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kala-windows-packager-test-'))
  try {
    const nodePtyRoot = join(dir, 'node-pty')
    const bytesByRuntimePath = createNodePtyFixture(nodePtyRoot)
    const archive = join(dir, windowsNodePtyCompanionAssetName())
    const manifest = packageWindowsNodePtyCompanion({ nodePtyRoot, outputPath: archive })
    assert.equal(manifest.target, 'win32-x64')
    assert.equal(manifest.nodePtyVersion, '1.1.0')
    assert.deepEqual(manifest.files.map((file) => file.path), WINDOWS_NODE_PTY_FILES)
    for (const file of manifest.files) {
      const bytes = bytesByRuntimePath.get(file.path)
      assert.ok(bytes)
      assert.equal(file.bytes, bytes.length)
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
    }
    assert.deepEqual(verifyWindowsNodePtyCompanion(archive, { expectedNodePtyVersion: '1.1.0' }), manifest)

    const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    const entries = listed.stdout.trim().split('\n').sort()
    assert.deepEqual(entries, [
      'node-pty-companion.json',
      'win32-x64/',
      ...WINDOWS_NODE_PTY_BINARY_FILES.map((name) => `win32-x64/${name}`),
      'worker/',
      'worker/conoutSocketWorker.js',
      'shared/',
      'shared/conout.js',
    ].sort())
    const embedded = spawnSync('tar', ['-xOzf', archive, 'node-pty-companion.json'], { encoding: 'utf8' })
    assert.equal(embedded.status, 0, embedded.stderr)
    assert.deepEqual(JSON.parse(embedded.stdout), manifest)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifier rejects a companion whose worker no longer matches its manifest digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kala-windows-packager-tamper-test-'))
  try {
    const nodePtyRoot = join(dir, 'node-pty')
    createNodePtyFixture(nodePtyRoot)
    const archive = join(dir, 'original.tar.gz')
    packageWindowsNodePtyCompanion({ nodePtyRoot, outputPath: archive })
    const extracted = join(dir, 'extracted')
    mkdirSync(extracted)
    assert.equal(spawnSync('tar', ['-xzf', archive, '-C', extracted]).status, 0)
    writeFileSync(join(extracted, 'worker', 'conoutSocketWorker.js'), 'tampered\n')
    const tampered = join(dir, 'tampered.tar.gz')
    assert.equal(spawnSync('tar', ['-czf', tampered, '-C', extracted, 'node-pty-companion.json', 'win32-x64', 'worker', 'shared']).status, 0)
    assert.throws(() => verifyWindowsNodePtyCompanion(tampered), /size mismatch|checksum mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails closed for missing, non-PE, missing worker, or unsupported companion inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kala-windows-packager-invalid-test-'))
  try {
    const prebuild = join(dir, 'prebuilds', WINDOWS_EXECUTOR_TARGET)
    mkdirSync(prebuild, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }))
    assert.throws(() => packageWindowsNodePtyCompanion({ nodePtyRoot: dir, outputPath: join(dir, 'missing.tar.gz') }), /missing prebuilds\/win32-x64\/conpty\.node/)
    for (const name of WINDOWS_NODE_PTY_BINARY_FILES) writeFileSync(join(prebuild, name), Buffer.from('not-a-pe'))
    assert.throws(() => packageWindowsNodePtyCompanion({ nodePtyRoot: dir, outputPath: join(dir, 'invalid.tar.gz') }), /not a Windows x64 PE binary/)
    for (const [index, name] of WINDOWS_NODE_PTY_BINARY_FILES.entries()) writeFileSync(join(prebuild, name), fakeWindowsX64Pe(index))
    assert.throws(() => packageWindowsNodePtyCompanion({ nodePtyRoot: dir, outputPath: join(dir, 'worker-missing.tar.gz') }), /missing worker\/conoutSocketWorker\.js/)
    assert.throws(() => windowsNodePtyCompanionAssetName('win32-arm64'), /unsupported Windows Executor target/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
