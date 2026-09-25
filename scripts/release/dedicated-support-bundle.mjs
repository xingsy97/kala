#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEDICATED_SUPPORT_ARCHIVE = 'kala-dedicated-support.tar.gz'
export const DEDICATED_SUPPORT_MANIFEST = 'dedicated-support-manifest.json'
export const DEDICATED_SUPPORT_ASSETS = Object.freeze([
  'cutover-dedicated-systemd.mjs',
  'dedicated-data-migration.mjs',
  'dedicated-settings-fingerprint.mjs',
  'deploy-dashboard.mjs',
  'deploy-dedicated.mjs',
  'deployment.json',
  'install-dedicated-systemd.mjs',
  'kala-dedicated-control-updater.service',
  'kala-dedicated-deploy-supervisor.service',
  'kala-dedicated-ingress.service',
  'kala-dedicated-migration-finalizer.service',
  'kala-dedicated-unit@.service',
  'rollback-dedicated-systemd.mjs',
  'update-dedicated-control-plane.mjs',
])

const sourcePaths = Object.freeze({
  'cutover-dedicated-systemd.mjs': 'scripts/deploy/cutover-dedicated-systemd.mjs',
  'dedicated-data-migration.mjs': 'scripts/deploy/dedicated-data-migration.mjs',
  'dedicated-settings-fingerprint.mjs': 'scripts/deploy/dedicated-settings-fingerprint.mjs',
  'deploy-dashboard.mjs': 'scripts/deploy/deploy-dashboard.mjs',
  'deploy-dedicated.mjs': 'scripts/deploy/deploy-dedicated.mjs',
  'deployment.json': 'deploy/dedicated-systemd/deployment.json',
  'install-dedicated-systemd.mjs': 'scripts/deploy/install-dedicated-systemd.mjs',
  'kala-dedicated-control-updater.service': 'deploy/dedicated-systemd/agent-runlab-dedicated-control-updater.service',
  'kala-dedicated-deploy-supervisor.service': 'deploy/dedicated-systemd/agent-runlab-dedicated-deploy-supervisor.service',
  'kala-dedicated-ingress.service': 'deploy/dedicated-systemd/agent-runlab-dedicated-ingress.service',
  'kala-dedicated-migration-finalizer.service': 'deploy/dedicated-systemd/agent-runlab-dedicated-migration-finalizer.service',
  'kala-dedicated-unit@.service': 'deploy/dedicated-systemd/agent-runlab-dedicated-unit@.service',
  'rollback-dedicated-systemd.mjs': 'scripts/deploy/rollback-dedicated-systemd.mjs',
  'update-dedicated-control-plane.mjs': 'scripts/deploy/update-dedicated-control-plane.mjs',
})

export function buildDedicatedSupportBundle({ root, output }) {
  const repositoryRoot = resolve(root)
  const target = resolve(output)
  mkdirSync(dirname(target), { recursive: true })
  const staging = mkdtempSync(join(tmpdir(), 'kala-dedicated-support-build-'))
  try {
    const assets = DEDICATED_SUPPORT_ASSETS.map((name) => {
      const bytes = readFileSync(join(repositoryRoot, sourcePaths[name]))
      writeFileSync(join(staging, name), bytes, { mode: 0o644 })
      return { name, bytes: bytes.length, sha256: sha256(bytes) }
    })
    writeFileSync(join(staging, DEDICATED_SUPPORT_MANIFEST), `${JSON.stringify({ schemaVersion: 1, product: 'kala-dedicated-support', assets }, null, 2)}\n`, { mode: 0o644 })
    const names = [...DEDICATED_SUPPORT_ASSETS, DEDICATED_SUPPORT_MANIFEST].sort()
    const tar = command('tar', ['--sort=name', '--format=ustar', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=0644', '-cf', '-', '--', ...names], { cwd: staging, encoding: null })
    const gzip = command('gzip', ['-n', '-9'], { input: tar.stdout, encoding: null })
    writeFileSync(target, gzip.stdout, { mode: 0o644 })
    return inspectDedicatedSupportBundle(target)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export function inspectDedicatedSupportBundle(archive) {
  const path = resolve(archive)
  const listing = capture('tar', ['-tzf', path]).split(/\r?\n/u).filter(Boolean)
  const verbose = capture('tar', ['-tvzf', path]).split(/\r?\n/u).filter(Boolean)
  const expected = [...DEDICATED_SUPPORT_ASSETS, DEDICATED_SUPPORT_MANIFEST].sort()
  if (listing.length !== verbose.length || verbose.some((line) => line[0] !== '-')) throw new Error('Dedicated support archive contains links or special entries')
  if (listing.some((name) => !safeName(name)) || JSON.stringify([...listing].sort()) !== JSON.stringify(expected)) throw new Error('Dedicated support archive entries do not exactly match the contract')
  const manifestBytes = extractMember(path, DEDICATED_SUPPORT_MANIFEST)
  const manifest = JSON.parse(String(manifestBytes))
  validateManifest(manifest)
  for (const asset of manifest.assets) {
    const bytes = extractMember(path, asset.name)
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`Dedicated support asset mismatch: ${asset.name}`)
  }
  return { manifest, sha256: sha256(readFileSync(path)) }
}

export function extractDedicatedSupportBundle(archive, destination) {
  const path = resolve(archive)
  const target = resolve(destination)
  const { manifest } = inspectDedicatedSupportBundle(path)
  if (existsSync(target)) {
    const current = lstatSync(target)
    if (!current.isDirectory() || readdirSync(target).length !== 0) throw new Error('Dedicated support extraction destination must be an empty directory')
  } else mkdirSync(target, { recursive: true, mode: 0o700 })
  command('tar', ['-xzf', path, '-C', target, '--no-same-owner', '--no-same-permissions', '--', ...DEDICATED_SUPPORT_ASSETS])
  const entries = readdirSync(target, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) || JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify([...DEDICATED_SUPPORT_ASSETS].sort())) throw new Error('Dedicated support extraction did not produce the exact file set')
  for (const asset of manifest.assets) {
    const file = join(target, asset.name)
    const bytes = readFileSync(file)
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`Dedicated support extracted asset mismatch: ${asset.name}`)
    chmodSync(file, 0o444)
  }
  return manifest
}

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || value.product !== 'kala-dedicated-support' || !Array.isArray(value.assets)) throw new Error('invalid Dedicated support manifest')
  const names = value.assets.map((asset) => asset?.name)
  if (JSON.stringify(names) !== JSON.stringify(DEDICATED_SUPPORT_ASSETS)) throw new Error('Dedicated support manifest asset closure is invalid')
  for (const asset of value.assets) if (!safeName(asset.name) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new Error('invalid Dedicated support manifest asset')
}

function extractMember(archive, name) { return command('tar', ['-xOzf', archive, '--', name], { encoding: null }).stdout }
function safeName(name) { return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(name) && !name.includes('/') && name !== '.' && name !== '..' }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function capture(program, args) { return String(command(program, args).stdout) }
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: options.cwd, input: options.input, encoding: options.encoding === null ? null : 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${program} failed: ${String(result.stderr || result.stdout || result.status)}`)
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2]
  if (action === 'build') {
    const root = process.argv[3] ?? resolve(import.meta.dirname, '../..')
    const output = process.argv[4] ?? join(root, 'release', DEDICATED_SUPPORT_ARCHIVE)
    process.stdout.write(`${JSON.stringify(buildDedicatedSupportBundle({ root, output }))}\n`)
  } else if (action === 'verify') {
    process.stdout.write(`${JSON.stringify(inspectDedicatedSupportBundle(process.argv[3]))}\n`)
  } else if (action === 'extract') {
    process.stdout.write(`${JSON.stringify(extractDedicatedSupportBundle(process.argv[3], process.argv[4]))}\n`)
  } else {
    process.stderr.write('Usage: dedicated-support-bundle.mjs <build [root output]|verify archive|extract archive destination>\n')
    process.exitCode = 2
  }
}
