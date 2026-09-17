#!/usr/bin/env node
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeSignedRepository } from './desktop-apt-repository.mjs'
import { packageIdentity, root, run, verifyBuild } from './desktop-provenance.mjs'

// This installs/removes the app: refuse anything except the task-owned disposable builder.
if (hostname() !== 'runlab-desktop-builder' || process.getuid() !== 0
    || process.env.RUNLAB_TEST_ONLY_APT !== 'isolated-builder') {
  throw new Error('TEST ONLY: run as root inside task-owned runlab-desktop-builder with RUNLAB_TEST_ONLY_APT=isolated-builder')
}
const [artifactArg] = process.argv.slice(2)
if (!artifactArg) throw new Error('Provide a controlled locally-built candidate .deb')
const artifact = resolve(artifactArg)
const { provenance } = verifyBuild(artifact)
if (!provenance.version.includes('~')) throw new Error('Expected prerelease candidate')
const finalVersion = provenance.version.split('~')[0]
const work = resolve(root, 'packages/desktop/.artifacts', `apt-${randomUUID().slice(0, 8)}`)
mkdirSync(work, { mode: 0o700 })
const originalHome = process.env.GNUPGHOME
const report = { testOnly: true, productionApproved: false, candidate: provenance.artifact, finalVersion, checks: [] }
try {
  process.env.GNUPGHOME = resolve(work, 'keyring')
  mkdirSync(process.env.GNUPGHOME, { mode: 0o700 })
  run('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'RunLab Disposable TEST ONLY <test@example.invalid>', 'ed25519', 'sign', '1d'])
  const listing = run('gpg', ['--batch', '--with-colons', '--list-secret-keys'])
  const fingerprint = listing.split('\n').find((line) => line.startsWith('fpr:')).split(':')[9]
  const repository = resolve(work, 'repository')
  writeSignedRepository(artifact, repository, fingerprint, 'RunLab TEST ONLY')
  const publicKey = resolve(work, 'test-only.gpg')
  copyFileSync(resolve(repository, 'agent-runlab-desktop-archive-keyring.gpg'), publicKey)
  const sources = resolve(work, 'test.sources')
  writeFileSync(sources, `Types: deb\nURIs: file:${repository}\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: ${publicKey}\n`)
  mkdirSync(resolve(work, 'lists/partial'), { recursive: true })
  mkdirSync(resolve(work, 'archives/partial'), { recursive: true })
  // Use only this disposable key/source/list/cache. Never alter global trust/sources.
  const options = ['-o', `Dir::Etc::sourcelist=${sources}`, '-o', 'Dir::Etc::sourceparts=-',
    '-o', 'Dir::Etc::trusted=-', '-o', 'Dir::Etc::trustedparts=-',
    '-o', `Dir::State::lists=${resolve(work, 'lists')}`, '-o', `Dir::Cache::archives=${resolve(work, 'archives')}`,
    '-o', 'APT::Sandbox::User=root', '-o', 'Acquire::Languages=none', '-o', 'APT::Get::List-Cleanup=0',
    '-o', 'APT::Update::Error-Mode=any']
  const apt = (...args) => run('apt-get', [...options, ...args], work)
  // The builder may have the old incorrectly ordered rc installed. Remove it first.
  run('dpkg', ['--remove', 'agent-runlab-desktop'])
  apt('update')
  apt('install', '-y', `agent-runlab-desktop=${provenance.version}`)
  assert.equal(run('dpkg-query', ['-W', '-f=${Version}', 'agent-runlab-desktop']), provenance.version)
  report.checks.push('signed candidate repository update and actual apt install')
  const tree = resolve(work, 'final-fixture')
  run('dpkg-deb', ['--raw-extract', artifact, tree])
  const control = resolve(tree, 'DEBIAN/control')
  writeFileSync(control, readFileSync(control, 'utf8').replace(/^Version: .+$/m, `Version: ${finalVersion}`))
  const finalArtifact = resolve(work, `agent-runlab-desktop_${finalVersion}_amd64.deb`)
  run('dpkg-deb', ['--root-owner-group', '--build', tree, finalArtifact])
  assert.equal(packageIdentity(finalArtifact).version, finalVersion)
  const replacement = resolve(work, 'replacement')
  writeSignedRepository(finalArtifact, replacement, fingerprint, 'RunLab TEST ONLY')
  renameSync(repository, resolve(work, 'previous'))
  renameSync(replacement, repository)
  apt('update')
  apt('install', '--only-upgrade', '-y', 'agent-runlab-desktop')
  assert.equal(run('dpkg-query', ['-W', '-f=${Version}', 'agent-runlab-desktop']), finalVersion)
  report.checks.push('normal apt upgrade selects final over ~rc (test-only repack, not a final native release)')
  const inRelease = resolve(repository, 'dists/stable/InRelease')
  writeFileSync(inRelease, readFileSync(inRelease, 'utf8').replace('Origin: RunLab TEST ONLY', 'Origin: Tampered TEST ONLY'))
  assert.throws(() => apt('update'), /apt-get failed/)
  report.checks.push('tampered InRelease rejected by apt signature verification')
  report.success = true
} finally {
  try { run('gpgconf', ['--kill', 'gpg-agent']) } finally {
    if (originalHome === undefined) delete process.env.GNUPGHOME
    else process.env.GNUPGHOME = originalHome
    rmSync(work, { recursive: true, force: true })
  }
  // Restore the real candidate after the ephemeral final-version package test.
  run('dpkg', ['--remove', 'agent-runlab-desktop'])
  run('dpkg', ['--install', artifact])
  writeFileSync(resolve(root, 'packages/desktop/.artifacts/apt-test-only-result.json'), `${JSON.stringify(report, null, 2)}\n`)
}
console.log(JSON.stringify(report, null, 2))
