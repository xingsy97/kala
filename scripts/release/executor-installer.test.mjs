import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'

import {
  executorNativeAssetName,
  generateExecutorInstallerPowerShell,
  generateExecutorInstallerSh,
  mapExecutorPlatform,
  windowsExecutorInstallerAssetName,
} from './executor-installer.mjs'

test('maps supported executor OS and architecture aliases', () => {
  assert.equal(mapExecutorPlatform('linux', 'x86_64'), 'linux-x64')
  assert.equal(mapExecutorPlatform('Linux', 'aarch64'), 'linux-arm64')
  assert.equal(mapExecutorPlatform('darwin', 'x86_64'), 'darwin-x64')
  assert.equal(mapExecutorPlatform('macos', 'arm64'), 'darwin-arm64')
  assert.equal(mapExecutorPlatform('windows', 'AMD64'), 'win32-x64')
  assert.equal(mapExecutorPlatform('mingw', 'x86_64'), 'win32-x64')
  assert.equal(mapExecutorPlatform('win32', 'arm64'), undefined)
  assert.equal(mapExecutorPlatform('freebsd', 'x64'), undefined)
  assert.equal(mapExecutorPlatform('linux', 'riscv64'), undefined)
})

test('uses one Kala namespace for native asset names', () => {
  assert.equal(executorNativeAssetName('linux-x64'), 'kala-executor-linux-x64')
  assert.equal(executorNativeAssetName('linux-arm64'), 'kala-executor-linux-arm64')
  assert.equal(executorNativeAssetName('darwin-x64'), 'kala-executor-darwin-x64')
  assert.equal(executorNativeAssetName('darwin-arm64'), 'kala-executor-darwin-arm64')
  assert.equal(executorNativeAssetName('win32-x64'), 'kala-executor-win32-x64.exe')
  assert.throws(() => executorNativeAssetName('win32-arm64'))
  assert.throws(() => executorNativeAssetName('freebsd-x64'))
})

test('generates HTTPS-only, checksummed Bash installer with native or Node.js fallback', () => {
  const sh = generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'v1.2.3' })
  for (const marker of [/release asset URL must use HTTPS/, /--https-only/, /SHA256SUMS/, /kala-executor-/, /--internal-installer/]) assert.match(sh, marker)
  assert.doesNotMatch(sh, /ALLOW_UNSIGNED|unsigned install/)
  assert.match(sh, /kala-executor\.cjs/)
  assert.match(sh, /Node\.js 22\+/)
  assert.doesNotMatch(sh, /manifest\.json/)
  assert.match(sh, /this release supports Linux and macOS only/)
  assert.doesNotMatch(sh, /win32|mingw|msys|cygwin|\.exe|\.ps1|conpty/iu)

  const dir = mkdtempSync(join(tmpdir(), 'runlab-installer-test-'))
  try {
    const path = join(dir, 'run.sh')
    writeFileSync(path, sh)
    const syntax = spawnSync('bash', ['-n', path], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, syntax.stderr)
    const closed = spawnSync('bash', [path], { encoding: 'utf8', env: { ...process.env, KALA_RELEASE_ASSETS_URL: 'http://downloads.example.test/release' } })
    assert.notEqual(closed.status, 0)
    assert.match(`${closed.stdout}${closed.stderr}`, /must use HTTPS/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('generates a signed-checksum Windows x64 installer with an exact ConPTY inventory', () => {
  const ps1 = generateExecutorInstallerPowerShell({ repo: 'owner/repo', tag: 'v1.2.3' })
  assert.equal(windowsExecutorInstallerAssetName(), 'install-executor.ps1')
  for (const marker of [
    /Windows x64/,
    /kala-executor-win32-x64\.exe/,
    /node-pty-win32-x64\.tar\.gz/,
    /kala-executor-service-host-win32-x64\.exe/,
    /SHA256SUMS\.sigstore\.json/,
    /cosign\.Source verify-blob/,
    /Get-FileHash -Algorithm SHA256/,
    /node-pty-companion\.json/,
    /conpty\.node/,
    /worker\/conoutSocketWorker\.js/,
    /shared\/conout\.js/,
    /manifest\.files\)\.Count -ne 7/,
    /unexpected file inventory/,
    /--internal-installer/,
  ]) assert.match(ps1, marker)
  assert.match(ps1, /Host-mediated release trust requires a valid internal installation session/)
  assert.match(ps1, /--invite-installer/)
  assert.match(ps1, /KALA_INVITE_INSTALL_MODE/)
  assert.match(ps1, /\$internalSession/)
  assert.match(ps1, /\$inviteSession/)
  assert.match(ps1, /if \(\$hostRelease\) \{ & \$binary @args \} else \{ & \$binary --internal-installer @args \}/)
  assert.doesNotMatch(ps1, /& \$binary --internal-installer @args\s*\n/u, 'organization invite must not execute the Host installation-session entry point')
  assert.match(ps1, /Release downloads require HTTPS except for loopback URLs/)
  assert.match(ps1, /SHA256SUMS must contain exactly one valid entry/)
  assert.match(ps1, /redirected away from the trusted Host/)
  assert.doesNotMatch(ps1, /ALLOW_UNSIGNED|winget|kala-executor\.cjs/iu)
})

test('release builder emits the four-target RC manifest with the Windows native installer', () => {
  const builder = readFileSync(new URL('./build-release-assets.mjs', import.meta.url), 'utf8')
  assert.match(builder, /sourceSnapshotSha256/u)
  assert.match(builder, /release source changed while assets were being built/u)
  assert.match(builder, /bootstrapAssets\.push\('run\.sh'\)/)
  assert.doesNotMatch(builder, /install-executor\.sh|generateExecutorInstallerSh/)
  assert.match(builder, /const nativeTargets = \['linux-x64', 'darwin-x64', 'darwin-arm64', WINDOWS_EXECUTOR_TARGET\]/)
  assert.match(builder, /name: 'kala-executor'/)
  assert.doesNotMatch(builder, /legacyExecutorNativeAssetName|runlab-executor/)
  assert.match(builder, /const supportedNativeBuildTargets = nativeTargets/)
  assert.match(builder, /packageWindowsNodePtyCompanion/)
  assert.match(builder, /stageWindowsServiceHost/)
  assert.match(builder, /windowsServiceHostManifestMetadata/)
  assert.match(builder, /generateExecutorInstallerPowerShell/)
  assert.match(builder, /Windows native release builds are Executor-only; Portable Host remains a Node\.js 22\+ CJS asset/)
  assert.match(builder, /Node SEA builds are not cross-compiled/)
  assert.doesNotMatch(builder, /writeExecutorUpdateManifest/)
})

test('generated run.sh executes the checksummed Node fallback from a real release directory', () => {
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
    const result = spawnSync('bash', [installer, '--host', 'https://host.invalid'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KALA_RELEASE_ASSETS_URL: 'https://assets.invalid', KALA_INSTALLER_WORK_DIR: work, FAKE_RELEASE_DIR: release, FAKE_NODE_ARGS: argsFile } })
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
    const result = spawnSync('bash', [installer], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}${result.stderr}`, /supports Linux and macOS only/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unexpected-download/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
