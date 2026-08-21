import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'

import {
  executorNativeAssetName,
  generateExecutorInstallerPs1,
  generateExecutorInstallerSh,
  legacyExecutorNativeAssetName,
  mapExecutorPlatform,
} from './executor-installer.mjs'

test('maps supported executor OS and architecture aliases', () => {
  assert.equal(mapExecutorPlatform('linux', 'x86_64'), 'linux-x64')
  assert.equal(mapExecutorPlatform('Linux', 'aarch64'), 'linux-arm64')
  assert.equal(mapExecutorPlatform('macos', 'arm64'), 'darwin-arm64')
  assert.equal(mapExecutorPlatform('windows', 'AMD64'), 'win32-x64')
  assert.equal(mapExecutorPlatform('freebsd', 'x64'), undefined)
  assert.equal(mapExecutorPlatform('linux', 'riscv64'), undefined)
})

test('uses product native names while retaining deterministic legacy names', () => {
  assert.equal(executorNativeAssetName('linux-x64'), 'runlab-executor-linux-x64')
  assert.equal(executorNativeAssetName('win32-arm64'), 'runlab-executor-win32-arm64.exe')
  assert.equal(legacyExecutorNativeAssetName('darwin-arm64'), 'agent-kernel-executor-darwin-arm64')
  assert.throws(() => executorNativeAssetName('freebsd-x64'))
})

test('generates fail-closed installers with checksummed native or Node.js fallback', () => {
  const sh = generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'v1.2.3' })
  const ps1 = generateExecutorInstallerPs1({ repo: 'owner/repo', tag: 'latest' })
  for (const text of [sh, ps1]) {
    assert.match(text, /RUNLAB_INSTALLER_ALLOW_UNSIGNED/)
    assert.match(text, /SHA256SUMS/)
    assert.match(text, /runlab-executor-/)
    assert.match(text, /--internal-installer/)
  }
  assert.match(sh, /agent-kernel-executor\.cjs/)
  assert.match(sh, /Node\.js 22\+/)
  assert.doesNotMatch(sh, /manifest\.json/)
  assert.match(ps1, /agent-kernel-executor\.cjs/)
  assert.match(ps1, /Get-Command node/)
  assert.match(ps1, /Get-FileHash -Algorithm SHA256/)
  assert.match(ps1, /Read-Host 'Install the official Node\.js LTS package with Windows Package Manager \(winget\)\? \[y\/N\]'/)
  assert.match(ps1, /winget\.Source install --id OpenJS\.NodeJS\.LTS --exact --source winget/)
  assert.match(ps1, /RUNLAB_INSTALL_NODE/)
  assert.match(ps1, /GetEnvironmentVariable\('Path', 'Machine'\)/)
  assert.match(ps1, /Node\.js installation was not approved/)
  assert.match(ps1, /node-pty-\$target\.tar\.gz/)
  assert.match(ps1, /Get-FileHash -Algorithm SHA256 \$ptyPath/)
  assert.match(ps1, /Join-Path \$work 'prebuilds'/)
  assert.doesNotMatch(ps1, /manifest\.json|RuntimeInformation\]::OSArchitecture/)

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

test('release builder emits both installer assets and product manifest mapping', () => {
  const builder = readFileSync(new URL('./build-release-assets.mjs', import.meta.url), 'utf8')
  assert.match(builder, /sourceSnapshotSha256/u)
  assert.match(builder, /release source changed while assets were being built/u)
  assert.match(builder, /generateExecutorInstallerSh/)
  assert.match(builder, /generateExecutorInstallerPs1/)
  assert.match(builder, /'runlab-executor': executorProductNatives/)
  assert.match(builder, /legacyExecutorNativeAssetName/)
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
    writeFileSync(join(release, 'agent-kernel-executor.cjs'), cjs)
    const hash = createHash('sha256').update(cjs).digest('hex')
    writeFileSync(join(release, 'SHA256SUMS'), `${hash}  agent-kernel-executor.cjs\n`)
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\n[ "$1" = -m ] && echo x86_64 || echo Linux\n', { mode: 0o755 })
    writeFileSync(join(bin, 'wget'), '#!/bin/sh\nout=""; while [ $# -gt 0 ]; do [ "$1" = -O ] && { out="$2"; shift 2; continue; }; url="$1"; shift; done; cp "$FAKE_RELEASE_DIR/${url##*/}" "$out"\n', { mode: 0o755 })
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nif [ "$1" = -p ]; then echo 22; exit 0; fi\nprintf "%s\\n" "$@" > "$FAKE_NODE_ARGS"\n', { mode: 0o755 })
    const installer = join(dir, 'install.sh')
    writeFileSync(installer, generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'latest' }), { mode: 0o755 })
    const argsFile = join(dir, 'node-args')
    const result = spawnSync('bash', [installer, '--host', 'https://host.invalid'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNLAB_INSTALLER_ALLOW_UNSIGNED: '1', RUNLAB_RELEASE_ASSETS_URL: 'https://assets.invalid', RUNLAB_INSTALLER_WORK_DIR: work, FAKE_RELEASE_DIR: release, FAKE_NODE_ARGS: argsFile } })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const invoked = readFileSync(argsFile, 'utf8')
    assert.match(invoked, /agent-kernel-executor\.cjs/)
    assert.match(invoked, /--internal-installer/)
    assert.match(invoked, /--host/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
