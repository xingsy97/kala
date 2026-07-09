#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const releaseDir = join(root, 'release')
const manifestPath = join(releaseDir, 'manifest.json')

if (!existsSync(manifestPath)) fail('missing release/manifest.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
  fail('manifest.assets must be a non-empty array')
}

for (const asset of manifest.assets) {
  const path = join(releaseDir, asset)
  if (!existsSync(path)) fail(`missing asset ${asset}`)
  if (asset.endsWith('.cjs')) {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#!/usr/bin/env node\n')) {
      fail(`${asset} is missing node shebang`)
    }
    accessSync(path, constants.X_OK)
  }
  if (asset.endsWith('.sh')) {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#!/usr/bin/env bash\n')) {
      fail(`${asset} is missing bash shebang`)
    }
    accessSync(path, constants.X_OK)
    const syntax = spawnSync('bash', ['-n', path], { stdio: 'inherit' })
    if (syntax.status !== 0) fail(`${asset} failed bash syntax check`)
  }
}

const notesPath = join(releaseDir, 'RELEASE_NOTES.md')
if (!existsSync(notesPath)) fail('missing release/RELEASE_NOTES.md')
const notes = readFileSync(notesPath, 'utf8')
if (manifest.assets.includes('run-host.sh') && !notes.includes('run-host.sh | bash')) {
  fail('release notes missing host bash one-liner')
}
if (manifest.assets.includes('run-executor.sh') && !notes.includes('run-executor.sh | HOST_URL=')) {
  fail('release notes missing executor bash one-liner')
}
if (/agent-kernel-(host|executor)\.cjs\s*\|\s*node/.test(notes)) {
  fail('release notes must not pipe Node.js assets directly to node')
}

const checksum = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], {
  cwd: releaseDir,
  stdio: 'inherit',
})
if (checksum.status !== 0) fail('SHA256SUMS verification failed')

if (manifest.assets.includes('agent-kernel-executor.cjs')) {
  const executor = spawnSync('node', ['agent-kernel-executor.cjs'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (executor.status !== 1) fail('executor usage smoke test should exit 1')
  const output = `${executor.stdout}\n${executor.stderr}`
  if (!output.includes('agent-kernel-executor --host')) {
    fail('executor usage smoke test did not print usage')
  }
}

console.log('release assets verified')

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exit(1)
}
