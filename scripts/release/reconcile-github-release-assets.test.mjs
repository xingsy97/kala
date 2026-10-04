import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import test from 'node:test'

const reconcile = join(import.meta.dirname, 'reconcile-github-release-assets.mjs')
const tag = 'v1.2.3-rc.1'
const coreAssets = ['SHA256SUMS', 'manifest.json']
const privateCloudAssets = ['linux-x64', 'linux-arm64'].flatMap((target) => [
  `kala-private-cloud-1.2.3-rc.1-${target}.tar.gz`,
  `private-cloud-${target}.sigstore.json`,
])

test('core reconciliation preserves only the strict Private Cloud asset set when Private Cloud uploads first', () => {
  withFixture([...privateCloudAssets, 'kala-private-cloud-1.2.2-linux-x64.tar.gz', 'stale-debug.zip'], ({ run, state, log }) => {
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(assets(state), [...coreAssets, ...privateCloudAssets].sort())
    const calls = readFileSync(log, 'utf8')
    assert.match(calls, /delete-asset.*kala-private-cloud-1\.2\.2-linux-x64\.tar\.gz/u)
    assert.match(calls, /delete-asset.*stale-debug\.zip/u)
    for (const name of privateCloudAssets) assert.doesNotMatch(calls, new RegExp(`delete-asset[^\n]+${escapeRegExp(name)}`, 'u'))
  })
})

test('core reconciliation accepts strict Private Cloud assets uploaded concurrently after its initial inventory', () => {
  withFixture(['stale-debug.zip'], ({ run, state }) => {
    const result = run({ GH_ADD_PRIVATE_CLOUD_ON_UPLOAD: 'true' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(assets(state), [...coreAssets, ...privateCloudAssets].sort())
  })
})

test('core reconciliation rejects an arbitrary asset that appears during upload', () => {
  withFixture([], ({ run }) => {
    const result = run({ GH_ADD_STALE_ON_UPLOAD: 'true' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unowned remote assets \["concurrent-stale\.zip"\]/u)
  })
})

function withFixture(initialAssets, check) {
  const temporary = mkdtempSync(join(tmpdir(), 'release-reconcile-ownership-'))
  try {
    const release = join(temporary, 'release')
    const bin = join(temporary, 'bin')
    mkdirSync(release)
    mkdirSync(bin)
    for (const name of coreAssets) writeFileSync(join(release, name), `${name}\n`)
    const state = join(temporary, 'assets.json')
    const log = join(temporary, 'gh.log')
    writeFileSync(state, JSON.stringify(initialAssets))
    writeFileSync(log, '')
    const fakeGh = join(bin, 'gh')
    writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); let assets = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'release' && args[1] === 'view') process.stdout.write(JSON.stringify({ assets: assets.map(name => ({ name })) }));
else if (args[0] === 'release' && args[1] === 'delete-asset') assets = assets.filter(name => name !== args[3]);
else if (args[0] === 'release' && args[1] === 'upload') {
  for (const file of args.slice(3, -1)) { const name = path.basename(file); if (!assets.includes(name)) assets.push(name); }
  if (process.env.GH_ADD_PRIVATE_CLOUD_ON_UPLOAD === 'true') {
    const names = ${JSON.stringify(privateCloudAssets)}; for (const name of names) if (!assets.includes(name)) assets.push(name);
  }
  if (process.env.GH_ADD_STALE_ON_UPLOAD === 'true') assets.push('concurrent-stale.zip');
} else process.exit(2);
fs.writeFileSync(process.env.GH_STATE, JSON.stringify(assets));
`)
    chmodSync(fakeGh, 0o755)
    const run = (extraEnv = {}) => spawnSync(process.execPath, [
      reconcile, '--tag', tag, '--directory', release, '--preserve-private-cloud-assets',
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STATE: state, GH_LOG: log, ...extraEnv },
    })
    check({ run, state, log })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function assets(state) { return JSON.parse(readFileSync(state, 'utf8')).sort() }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }
