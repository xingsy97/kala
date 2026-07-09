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
  if (isNativeAsset(asset)) {
    accessSync(path, constants.X_OK)
  }
  if (asset.endsWith('.sh')) {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#!/usr/bin/env bash\n')) {
      fail(`${asset} is missing bash shebang`)
    }
    accessSync(path, constants.X_OK)
    if (asset !== 'run.sh') fail(`unexpected shell bootstrap ${asset}; use run.sh only`)
    if (text.includes('curl')) fail(`${asset} must be wget-only and must not mention curl`)
    if (!text.includes('AGENT_KERNEL_RUNTIME:-auto')) {
      fail(`${asset} must support AGENT_KERNEL_RUNTIME=auto|cjs|native`)
    }
    if (!text.includes('[ "$runtime" = "auto" ] && has_node22')) {
      fail(`${asset} must prefer compact .cjs assets when Node.js 22+ is available`)
    }
    const syntax = spawnSync('bash', ['-n', path], { stdio: 'inherit' })
    if (syntax.status !== 0) fail(`${asset} failed bash syntax check`)
  }
}

const shellAssets = manifest.assets.filter((asset) => asset.endsWith('.sh'))
if (shellAssets.length > 1) fail(`expected at most one shell bootstrap, got ${shellAssets.join(', ')}`)

const notesPath = join(releaseDir, 'RELEASE_NOTES.md')
if (!existsSync(notesPath)) fail('missing release/RELEASE_NOTES.md')
const notes = readFileSync(notesPath, 'utf8')
if (manifest.assets.includes('run.sh') && !notes.includes('run.sh | COMPONENT=')) {
  fail('release notes missing unified bash one-liner')
}
if (notes.includes('curl ')) {
  fail('release notes must not mention curl')
}
if (notes.includes('run-host.sh') || notes.includes('run-executor.sh')) {
  fail('release notes must use unified run.sh only')
}
if (!notes.includes('sha256sum -c SHA256SUMS --ignore-missing')) {
  fail('release notes missing checksum verification command')
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

const nativeExecutor = manifest.assets.find((asset) => asset === nativeAssetName('agent-kernel-executor'))
if (nativeExecutor) {
  const executor = spawnSync(`./${nativeExecutor}`, [], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (executor.status !== 1) fail('native executor usage smoke test should exit 1')
  const output = `${executor.stdout}\n${executor.stderr}`
  if (!output.includes('agent-kernel-executor --host')) {
    fail('native executor usage smoke test did not print usage')
  }
}

console.log('release assets verified')

function isNativeAsset(asset) {
  return /^agent-kernel-(host|executor)-(linux|darwin|win32)-(x64|arm64)(\.exe)?$/.test(asset)
}

function nativeAssetName(base) {
  const os = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  return `${base}-${os}-${arch}${os === 'win32' ? '.exe' : ''}`
}

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exit(1)
}
