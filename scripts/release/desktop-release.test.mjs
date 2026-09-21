import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { debianVersion, run, sha, verifyBuild } from './desktop-provenance.mjs'
import { stage } from './stage-desktop-release.mjs'

function fixture(t, sourceVersion = '0.2.0-rc.1', base) {
  const directory = base ?? resolve('packages/desktop/.artifacts', `pipeline-test-${randomUUID()}`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!base) t.after(() => rmSync(directory, { recursive: true, force: true }))
  const version = debianVersion(sourceVersion)
  const packageRoot = resolve(directory, `package-${version}`)
  mkdirSync(resolve(packageRoot, 'DEBIAN'), { recursive: true, mode: 0o755 })
  chmodSync(resolve(packageRoot, 'DEBIAN'), 0o755)
  writeFileSync(resolve(packageRoot, 'DEBIAN/control'), `Package: kala-desktop\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Test Only <test@example.invalid>\nDescription: pipeline fixture, not a native release\n`)
  const file = `kala-desktop_${version}_amd64.deb`
  const artifact = resolve(directory, file)
  run('dpkg-deb', ['--root-owner-group', '--build', packageRoot, artifact])
  const bytes = readFileSync(artifact)
  const registry = resolve(directory, 'test-only-registry')
  const record = resolve(registry, sha(bytes))
  mkdirSync(record, { recursive: true, mode: 0o700 })
  const inputs = Object.fromEntries(['Cargo.lock', 'pnpm-lock.yaml', 'desktop-package.json', 'tauri.conf.json', 'rust-toolchain.toml'].map((name) => {
    writeFileSync(resolve(record, name), `${name}: fixture\n`, { mode: 0o600 })
    return [name, sha(readFileSync(resolve(record, name)))]
  }))
  const provenance = {
    schemaVersion: 2, sourceVersion, version, inputs,
    sourceCommit: 'a'.repeat(40), sourceDirty: true,
    toolchain: { rust: 'test-only', cargo: 'test-only', node: 'test-only', pnpm: 'test-only', tauriCli: 'test-only' },
    rust: [], javascript: [],
    artifact: { file, sha256: sha(bytes), size: bytes.length },
    build: { status: 'succeeded', cargoLocked: true, pnpmFrozenLockfile: true, sourceDateEpoch: 1 },
    signature: { status: 'unsigned' }, security: { status: 'review-required' },
  }
  const save = () => {
    const content = JSON.stringify(provenance)
    writeFileSync(resolve(record, 'dependencies.json'), content, { mode: 0o600 })
    writeFileSync(resolve(record, 'receipt.json'), JSON.stringify({ schemaVersion: 1, artifactSha256: sha(bytes), provenanceSha256: sha(content) }), { mode: 0o600 })
  }
  save()
  return { directory, artifact, registry, record, provenance, save }
}

test('Debian prereleases upgrade to final; unsupported versions fail closed', () => {
  for (const [lower, higher] of [['0.2.0-rc.1', '0.2.0-rc.2'], ['0.2.0-rc.2', '0.2.0'], ['0.2.0', '0.2.1']]) {
    run('dpkg', ['--compare-versions', debianVersion(lower), 'lt', debianVersion(higher)])
  }
  for (const bad of ['0.2.0+meta', 'bad', '0.2.0\n']) assert.throws(() => debianVersion(bad))
})

test('local receipt binds artifact, provenance, lock snapshots and success flags', (t) => {
  const f = fixture(t)
  assert.equal(verifyBuild(f.artifact, f.registry).identity.version, '0.2.0~rc.1')
  const original = readFileSync(f.artifact)
  writeFileSync(f.artifact, Buffer.concat([original, Buffer.from('tamper')]))
  assert.throws(() => verifyBuild(f.artifact, f.registry))
  writeFileSync(f.artifact, original)
  for (const lock of ['Cargo.lock', 'pnpm-lock.yaml']) {
    writeFileSync(resolve(f.record, lock), 'different lock')
    assert.throws(() => verifyBuild(f.artifact, f.registry), /input digest mismatch/)
    writeFileSync(resolve(f.record, lock), `${lock}: fixture\n`)
  }
  writeFileSync(resolve(f.record, 'dependencies.json'), '{}')
  assert.throws(() => verifyBuild(f.artifact, f.registry), /provenance digest mismatch/)
  f.save()
  f.provenance.artifact.size += 1
  f.save()
  assert.throws(() => verifyBuild(f.artifact, f.registry), /successful locked-build/)
  f.provenance.artifact.size -= 1
  const savedToolchain = f.provenance.toolchain
  delete f.provenance.toolchain
  f.save()
  assert.throws(() => verifyBuild(f.artifact, f.registry), /dependency\/toolchain provenance/)
  f.provenance.toolchain = savedToolchain
  f.provenance.build.cargoLocked = false
  f.save()
  assert.throws(() => verifyBuild(f.artifact, f.registry), /successful locked-build/)
  f.provenance.build.cargoLocked = true
  f.provenance.sourceVersion = '0.3.0'
  f.save()
  assert.throws(() => verifyBuild(f.artifact, f.registry), /version\/provenance mismatch/)
})

test('supplied manifest alone and writable registry are never verified builds', (t) => {
  const f = fixture(t)
  rmSync(resolve(f.record, 'receipt.json'))
  assert.throws(() => verifyBuild(f.artifact, f.registry))
  f.save()
  chmodSync(f.registry, 0o755)
  assert.throws(() => verifyBuild(f.artifact, f.registry), /owner-only/)
})

test('staging preserves prior exact metadata links, rejects collisions, missing deb cannot pass verification', (t) => {
  const f = fixture(t)
  const output = resolve(f.directory, 'downloads')
  const first = stage(f.artifact, output, f.registry)
  const prior = new Map([first.artifact.file, first.dependencies.file, first.checksums.file].map((file) => [file, readFileSync(resolve(output, file))]))
  const next = fixture(t, '0.2.0', f.directory)
  stage(next.artifact, output, next.registry)
  for (const [file, bytes] of prior) assert.deepEqual(readFileSync(resolve(output, file)), bytes)
  run('sha256sum', ['--strict', '--check', first.checksums.file], output)
  rmSync(resolve(output, first.artifact.file))
  assert.notEqual(spawnSync('sha256sum', ['--strict', '--check', first.checksums.file], { cwd: output }).status, 0)
  writeFileSync(resolve(output, first.artifact.file), 'different package')
  assert.throws(() => stage(f.artifact, output, f.registry), /Immutable release collision/)
})

test('publisher audits artifact snapshot and has no candidate audit bypass', () => {
  const publisher = readFileSync(new URL('./publish-desktop-apt.mjs', import.meta.url), 'utf8')
  assert.match(publisher, /verifyBuild\(artifact\)/)
  assert.match(publisher, /resolve\(buildRecord, 'Cargo.lock'\), '--deny', 'unsound'/)
  assert.match(publisher, /'pnpm', \['audit', '--lockfile-dir', buildRecord/)
  assert.doesNotMatch(publisher, /skip.audit|allow.unsigned|allow.vulnerab/)
})
