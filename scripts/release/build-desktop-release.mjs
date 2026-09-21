#!/usr/bin/env node
import { existsSync, lutimesSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { debianVersion, packageIdentity, root, run, sha, trustRoot } from './desktop-provenance.mjs'

process.umask(0o077)
if (process.argv.length > 2) throw new Error('This controlled builder accepts no prebuilt artifact or supplied provenance')
const desktop = resolve(root, 'packages/desktop')
const native = resolve(desktop, 'src-tauri')
const sourceVersion = JSON.parse(readFileSync(resolve(desktop, 'package.json'))).version
const version = debianVersion(sourceVersion)
const sourceEpoch = run('git', ['show', '-s', '--format=%ct', 'HEAD'])
const epoch = Number(sourceEpoch)
if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('Invalid source epoch')
const env = { ...process.env, SOURCE_DATE_EPOCH: sourceEpoch, CARGO_INCREMENTAL: '0' }
const inputs = {
  'Cargo.lock': resolve(native, 'Cargo.lock'),
  'pnpm-lock.yaml': resolve(root, 'pnpm-lock.yaml'),
  'desktop-package.json': resolve(desktop, 'package.json'),
  'tauri.conf.json': resolve(native, 'tauri.conf.json'),
  'rust-toolchain.toml': resolve(native, 'rust-toolchain.toml'),
  'Cargo.toml': resolve(native, 'Cargo.toml'),
  'root-package.json': resolve(root, 'package.json'),
  'pnpm-workspace.yaml': resolve(root, 'pnpm-workspace.yaml'),
}
const snapshots = Object.fromEntries(Object.entries(inputs).map(([name, path]) => [name, readFileSync(path)]))
const config = JSON.parse(snapshots['tauri.conf.json'])
if (config.version !== sourceVersion) throw new Error('Desktop and Tauri versions differ')
const toolchain = {
  rust: run('rustc', ['--version', '--verbose'], native), cargo: run('cargo', ['--version'], native),
  node: process.version, pnpm: run('pnpm', ['--version']),
  dpkgDeb: run('dpkg-deb', ['--version']),
  platform: readFileSync('/etc/os-release', 'utf8'),
}
const redact = (value) => Array.isArray(value) ? value.map(redact) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'path').map(([key, item]) => [key, redact(item)])) : value
run('pnpm', ['--filter', '@agent-kernel/desktop', 'install', '--frozen-lockfile'], root, { env, stdio: 'inherit' })
toolchain.tauriCli = run('pnpm', ['exec', 'tauri', '--version'], desktop)
const javascript = redact(JSON.parse(run('pnpm', ['--filter', '@agent-kernel/desktop', 'list', '--depth', 'Infinity', '--json'])))
const rust = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1'], native)).packages.map(({ name, version, source, license }) => ({ name, version, source, license }))
const bundle = resolve(native, 'target/release/bundle/deb')
rmSync(bundle, { recursive: true, force: true })
run('pnpm', ['exec', 'tauri', 'build', '--bundles', 'deb', '--', '--locked'], desktop, { env, stdio: 'inherit' })
for (const [name, path] of Object.entries(inputs)) {
  if (!snapshots[name].equals(readFileSync(path))) throw new Error(`Input changed during build: ${name}`)
}
const candidates = readdirSync(bundle).filter((name) => name.endsWith('.deb'))
if (candidates.length !== 1) throw new Error('Expected exactly one fresh Tauri Debian artifact')
const original = resolve(bundle, candidates[0])
if (packageIdentity(original).version !== sourceVersion) throw new Error('Unexpected Tauri package version')
const work = resolve(desktop, `.artifacts/normalize-${randomUUID()}`)
mkdirSync(work, { recursive: true })
let artifact
try {
  // Tauri has no Debian version override. Change only control Version; preserve payload.
  run('dpkg-deb', ['--raw-extract', original, resolve(work, 'package')])
  const control = resolve(work, 'package/DEBIAN/control')
  const text = readFileSync(control, 'utf8')
  if ((text.match(/^Version: .+$/gm) ?? []).length !== 1) throw new Error('Ambiguous Debian Version field')
  for (const field of ['Provides', 'Conflicts', 'Replaces']) {
    if (new RegExp(`^${field}:`, 'm').test(text)) throw new Error(`Unexpected pre-existing Debian ${field} field`)
  }
  const compatibility = 'Provides: agent-runlab-desktop\nConflicts: agent-runlab-desktop\nReplaces: agent-runlab-desktop\n'
  writeFileSync(control, text.replace(/^Version: .+$/m, `Version: ${version}\n${compatibility.trimEnd()}`))
  const md5sums = resolve(work, 'package/DEBIAN/md5sums')
  if (existsSync(md5sums)) {
    const entries = readFileSync(md5sums, 'utf8').split('\n').filter(Boolean).sort()
    writeFileSync(md5sums, `${entries.join('\n')}\n`)
  }
  const normalize = (path) => {
    const info = statSync(path)
    if (info.isDirectory()) for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) lutimesSync(resolve(path, entry.name), epoch, epoch)
      else normalize(resolve(path, entry.name))
    }
    utimesSync(path, epoch, epoch)
  }
  normalize(resolve(work, 'package'))
  artifact = resolve(desktop, `.artifacts/kala-desktop_${version}_amd64.deb`)
  const pending = resolve(work, basename(artifact))
  run('dpkg-deb', ['--root-owner-group', '-Zxz', '-z9', '--threads-max=1', '--build', resolve(work, 'package'), pending], root, { env })
  if (existsSync(artifact) && sha(readFileSync(artifact)) !== sha(readFileSync(pending))) throw new Error('Refusing to overwrite an existing version artifact; bump version')
  renameSync(pending, artifact)
} finally { rmSync(work, { recursive: true, force: true }) }
const identity = packageIdentity(artifact)
const digest = sha(readFileSync(artifact))
const provenance = {
  schemaVersion: 2, product: identity.package, version, sourceVersion,
  artifact: { file: basename(artifact), size: statSync(artifact).size, sha256: digest },
  generatedAt: new Date().toISOString(),
  sourceCommit: run('git', ['rev-parse', 'HEAD']), sourceDirty: run('git', ['status', '--porcelain']).length > 0,
  inputs: Object.fromEntries(Object.entries(snapshots).map(([name, bytes]) => [name, sha(bytes)])),
  toolchain, build: { status: 'succeeded', cargoLocked: true, pnpmFrozenLockfile: true, sourceDateEpoch: epoch, packaging: 'dpkg root-owner-group xz9 single-thread; Debian prerelease ~; normalized timestamps' },
  systemDependencies: run('dpkg-deb', ['-f', artifact, 'Depends']), rust, javascript,
  dashboard: 'Remote Dashboard is not bundled; its deployment owns its dependencies.',
  signature: { status: 'unsigned', aptRepositoryConfigured: false },
  security: { status: 'review-required', assessment: 'docs/operations/linux-desktop-supply-chain.md' },
  trust: 'Unsigned local controlled-build record; not publisher authentication. Never import untrusted registries.',
}
mkdirSync(trustRoot, { recursive: true, mode: 0o700 })
const record = resolve(trustRoot, digest)
if (existsSync(record)) throw new Error('Build record already exists; immutable records cannot be replaced')
const pending = resolve(trustRoot, `.incoming-${randomUUID()}`)
mkdirSync(pending, { mode: 0o700 })
for (const [name, bytes] of Object.entries(snapshots)) writeFileSync(resolve(pending, name), bytes, { mode: 0o600 })
const bytes = `${JSON.stringify(provenance, null, 2)}\n`
writeFileSync(resolve(pending, 'dependencies.json'), bytes, { mode: 0o600 })
writeFileSync(resolve(pending, 'receipt.json'), `${JSON.stringify({ schemaVersion: 1, artifactSha256: digest, provenanceSha256: sha(bytes) })}\n`, { mode: 0o600 })
renameSync(pending, record)
console.log(`Successful controlled locked build: ${artifact}\nSHA-256: ${digest}\nLocal provenance registry: ${record}`)
