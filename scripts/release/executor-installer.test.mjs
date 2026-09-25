import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'

import {
  executorNativeAssetName,
  generateExecutorInstallerSh,
  mapExecutorPlatform,
} from './executor-installer.mjs'

test('maps supported executor OS and architecture aliases', () => {
  assert.equal(mapExecutorPlatform('linux', 'x86_64'), 'linux-x64')
  assert.equal(mapExecutorPlatform('Linux', 'aarch64'), 'linux-arm64')
  assert.equal(mapExecutorPlatform('darwin', 'x86_64'), 'darwin-x64')
  assert.equal(mapExecutorPlatform('macos', 'arm64'), 'darwin-arm64')
  assert.equal(mapExecutorPlatform('windows', 'AMD64'), undefined)
  assert.equal(mapExecutorPlatform('win32', 'arm64'), undefined)
  assert.equal(mapExecutorPlatform('freebsd', 'x64'), undefined)
  assert.equal(mapExecutorPlatform('linux', 'riscv64'), undefined)
})

test('uses one Kala namespace for native asset names', () => {
  assert.equal(executorNativeAssetName('linux-x64'), 'kala-executor-linux-x64')
  assert.equal(executorNativeAssetName('linux-arm64'), 'kala-executor-linux-arm64')
  assert.equal(executorNativeAssetName('darwin-x64'), 'kala-executor-darwin-x64')
  assert.equal(executorNativeAssetName('darwin-arm64'), 'kala-executor-darwin-arm64')
  assert.throws(() => executorNativeAssetName('win32-arm64'))
  assert.throws(() => executorNativeAssetName('freebsd-x64'))
})

test('generates fail-closed installers with checksummed native or Node.js fallback', () => {
  const sh = generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'v1.2.3' })
  for (const marker of [/RUNLAB_INSTALLER_ALLOW_UNSIGNED/, /SHA256SUMS/, /kala-executor-/, /--internal-installer/]) assert.match(sh, marker)
  assert.match(sh, /kala-executor\.cjs/)
  assert.match(sh, /Node\.js 22\+/)
  assert.doesNotMatch(sh, /manifest\.json/)
  assert.match(sh, /this release supports Linux and macOS only/)
  assert.doesNotMatch(sh, /win32|mingw|msys|cygwin|\.exe|\.ps1|conpty/iu)

  const dir = mkdtempSync(join(tmpdir(), 'runlab-installer-test-'))
  try {
    const path = join(dir, 'install-executor.sh')
    writeFileSync(path, sh)
    const syntax = spawnSync('bash', ['-n', path], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, syntax.stderr)
    const closed = spawnSync('bash', [path], { encoding: 'utf8', env: { ...process.env, RUNLAB_INSTALLER_ALLOW_UNSIGNED: '' } })
    assert.notEqual(closed.status, 0)
    assert.match(`${closed.stdout}${closed.stderr}`, /signatures are not available/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('release builder emits the three-target RC manifest while preserving installer platform capabilities', () => {
  const builder = readFileSync(new URL('./build-release-assets.mjs', import.meta.url), 'utf8')
  assert.match(builder, /sourceSnapshotSha256/u)
  assert.match(builder, /release source changed while assets were being built/u)
  assert.match(builder, /generateExecutorInstallerSh/)
  assert.match(builder, /const nativeTargets = \['linux-x64', 'darwin-x64', 'darwin-arm64'\]/)
  assert.match(builder, /name: 'kala-executor'/)
  assert.doesNotMatch(builder, /legacyExecutorNativeAssetName|runlab-executor/)
  assert.doesNotMatch(builder, /generateExecutorInstallerPs1|node-pty-win32|writeExecutorUpdateManifest/)
})

test('generated shell installer executes the checksummed Node fallback from a real release directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runlab-installer-e2e-'))
  const release = join(dir, 'release')
  const bin = join(dir, 'bin')
  const work = join(dir, 'work')
  try {
    mkdirSync(release, { recursive: true })
    mkdirSync(bin, { recursive: true })
    const cjs = 'console.log("fallback executor invoked")\n'
    writeFileSync(join(release, 'kala-executor.cjs'), cjs)
    const hash = createHash('sha256').update(cjs).digest('hex')
    writeFileSync(join(release, 'SHA256SUMS'), `${hash}  kala-executor.cjs\n`)
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\n[ "$1" = -m ] && echo x86_64 || echo Linux\n', { mode: 0o755 })
    writeFileSync(join(bin, 'wget'), '#!/bin/sh\nout=""; while [ $# -gt 0 ]; do [ "$1" = -O ] && { out="$2"; shift 2; continue; }; url="$1"; shift; done; cp "$FAKE_RELEASE_DIR/${url##*/}" "$out"\n', { mode: 0o755 })
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nif [ "$1" = -p ]; then echo 22; exit 0; fi\nprintf "%s\\n" "$@" > "$FAKE_NODE_ARGS"\n', { mode: 0o755 })
    const installer = join(dir, 'install.sh')
    writeFileSync(installer, generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'latest' }), { mode: 0o755 })
    const argsFile = join(dir, 'node-args')
    const result = spawnSync('bash', [installer, '--host', 'https://host.invalid'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNLAB_INSTALLER_ALLOW_UNSIGNED: '1', RUNLAB_RELEASE_ASSETS_URL: 'https://assets.invalid', RUNLAB_INSTALLER_WORK_DIR: work, FAKE_RELEASE_DIR: release, FAKE_NODE_ARGS: argsFile } })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const invoked = readFileSync(argsFile, 'utf8')
    assert.match(invoked, /kala-executor\.cjs/)
    assert.match(invoked, /--internal-installer/)
    assert.match(invoked, /--host/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('generated shell installer rejects Windows before downloading release metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runlab-installer-windows-test-'))
  const bin = join(dir, 'bin')
  try {
    mkdirSync(bin)
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\n[ "$1" = -m ] && echo x86_64 || echo MINGW64_NT\n', { mode: 0o755 })
    writeFileSync(join(bin, 'wget'), '#!/bin/sh\necho unexpected-download >&2\nexit 99\n', { mode: 0o755 })
    const installer = join(dir, 'install.sh')
    writeFileSync(installer, generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'latest' }), { mode: 0o755 })
    const result = spawnSync('bash', [installer], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNLAB_INSTALLER_ALLOW_UNSIGNED: '1' } })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}${result.stderr}`, /supports Linux and macOS only/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unexpected-download/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
