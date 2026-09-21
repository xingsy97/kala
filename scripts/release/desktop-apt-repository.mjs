import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { run, sha } from './desktop-provenance.mjs'

// Low-level signing mechanics shared with the isolated TEST-ONLY integration.
// Production callers must enforce controlled provenance and audits before invoking.
export function writeSignedRepository(artifact, output, fingerprint, origin = 'Kala', expectedSha256) {
  if (existsSync(output)) throw new Error('Output must be a new directory; publish a verified staging tree atomically')
  run('gpg', ['--batch', '--list-secret-keys', fingerprint])
  const pool = resolve(output, 'pool/main/a/kala-desktop')
  const distribution = resolve(output, 'dists/stable')
  const binary = resolve(distribution, 'main/binary-amd64')
  mkdirSync(pool, { recursive: true })
  mkdirSync(binary, { recursive: true })
  const artifactBytes = readFileSync(artifact)
  if (expectedSha256 && sha(artifactBytes) !== expectedSha256) throw new Error('Artifact changed before signing')
  writeFileSync(resolve(pool, basename(artifact)), artifactBytes)
  const packages = `${run('apt-ftparchive', ['packages', 'pool'], output)}\n`
  writeFileSync(resolve(binary, 'Packages'), packages)
  writeFileSync(resolve(binary, 'Packages.gz'), gzipSync(packages))
  const release = run('apt-ftparchive', [
    '-o', `APT::FTPArchive::Release::Origin=${origin}`,
    '-o', `APT::FTPArchive::Release::Label=${origin} Desktop`,
    '-o', 'APT::FTPArchive::Release::Suite=stable',
    '-o', 'APT::FTPArchive::Release::Codename=stable',
    '-o', 'APT::FTPArchive::Release::Architectures=amd64',
    '-o', 'APT::FTPArchive::Release::Components=main',
    'release', 'dists/stable',
  ], output)
  writeFileSync(resolve(distribution, 'Release'), `Valid-Until: ${new Date(Date.now() + 14 * 86400_000).toUTCString()}\n${release}\n`)
  run('gpg', ['--batch', '--yes', '--local-user', fingerprint, '--digest-algo', 'SHA256', '--clearsign', '--output', resolve(distribution, 'InRelease'), resolve(distribution, 'Release')])
  run('gpg', ['--batch', '--yes', '--local-user', fingerprint, '--digest-algo', 'SHA256', '--armor', '--detach-sign', '--output', resolve(distribution, 'Release.gpg'), resolve(distribution, 'Release')])
  const key = spawnSync('gpg', ['--batch', '--export', fingerprint], { maxBuffer: 1024 * 1024 })
  if (key.status !== 0 || key.stdout.length === 0) throw new Error('Public key export failed')
  writeFileSync(resolve(output, 'kala-desktop-archive-keyring.gpg'), key.stdout)
  run('gpgv', ['--keyring', resolve(output, 'kala-desktop-archive-keyring.gpg'), resolve(distribution, 'InRelease')])
}
