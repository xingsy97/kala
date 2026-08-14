import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('generates fail-closed installers that require checksummed native executables', () => {
  const sh = generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'v1.2.3' })
  const ps1 = generateExecutorInstallerPs1({ repo: 'owner/repo', tag: 'latest' })
  for (const text of [sh, ps1]) {
    assert.match(text, /RUNLAB_INSTALLER_ALLOW_UNSIGNED/)
    assert.match(text, /SHA256SUMS/)
    assert.match(text, /runlab-executor-/)
    assert.match(text, /--internal-installer/)
  }
  assert.doesNotMatch(sh, /agent-kernel-executor\.cjs|manifest\.json/)
  assert.doesNotMatch(ps1, /agent-kernel-executor\.cjs|manifest\.json/)

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
  assert.match(builder, /generateExecutorInstallerSh/)
  assert.match(builder, /generateExecutorInstallerPs1/)
  assert.match(builder, /'runlab-executor': executorProductNatives/)
  assert.match(builder, /legacyExecutorNativeAssetName/)
})
