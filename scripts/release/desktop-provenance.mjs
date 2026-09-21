import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const trustRoot = resolve(root, 'packages/desktop/.build-provenance')
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function run(command, args, cwd = root, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ''}\n${result.stdout ?? ''}`)
  return result.stdout?.trim()
}
export function debianVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Unsupported desktop version (build metadata is not a release version)')
  return version.replace('-', '~')
}
export function packageIdentity(artifact) {
  const field = (name) => run('dpkg-deb', ['-f', artifact, name])
  const identity = { package: field('Package'), version: field('Version'), architecture: field('Architecture') }
  if (identity.package !== 'kala-desktop' || identity.architecture !== 'amd64') throw new Error('Expected kala-desktop Linux amd64 package')
  return identity
}
function controlled(path, directory = false) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
      || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error(`Build provenance must be owner-only, locally controlled, and not a symlink: ${path}`)
  }
}
// This registry is a local build boundary, NOT an attestation supplied with a .deb.
// A user able to alter the builder/registry can forge it; it conveys no publisher authenticity.
export function verifyBuild(artifact, registry = trustRoot) {
  artifact = resolve(artifact)
  controlled(registry, true)
  if (realpathSync(registry) !== registry) throw new Error('Symlinked build registry is not trusted')
  const digest = sha(readFileSync(artifact))
  const directory = resolve(registry, digest)
  controlled(directory, true)
  const receiptPath = resolve(directory, 'receipt.json')
  controlled(receiptPath)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  const provenancePath = resolve(directory, 'dependencies.json')
  controlled(provenancePath)
  const bytes = readFileSync(provenancePath)
  if (receipt.schemaVersion !== 1 || receipt.artifactSha256 !== digest || receipt.provenanceSha256 !== sha(bytes)) throw new Error('Build receipt/provenance digest mismatch')
  const provenance = JSON.parse(bytes)
  if (provenance.schemaVersion !== 2 || provenance.artifact?.sha256 !== digest
      || provenance.artifact?.size !== statSync(artifact).size || provenance.artifact?.file !== basename(artifact)
      || provenance.build?.cargoLocked !== true || provenance.build?.pnpmFrozenLockfile !== true
      || provenance.build?.status !== 'succeeded') throw new Error('Artifact does not match successful locked-build provenance')
  if (!['rust', 'cargo', 'node', 'pnpm', 'tauriCli'].every((key) => typeof provenance.toolchain?.[key] === 'string' && provenance.toolchain[key].length > 0)
      || !Array.isArray(provenance.rust) || !Array.isArray(provenance.javascript)
      || !/^[a-f0-9]{40,64}$/.test(provenance.sourceCommit ?? '')
      || typeof provenance.sourceDirty !== 'boolean'
      || !Number.isSafeInteger(provenance.build.sourceDateEpoch) || provenance.build.sourceDateEpoch <= 0) {
    throw new Error('Incomplete build dependency/toolchain provenance')
  }
  for (const [name, digest] of Object.entries(provenance.inputs ?? {})) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid provenance input')
    const path = resolve(directory, name)
    controlled(path)
    if (sha(readFileSync(path)) !== digest) throw new Error(`Build input digest mismatch: ${name}`)
  }
  for (const required of ['Cargo.lock', 'pnpm-lock.yaml', 'desktop-package.json', 'tauri.conf.json', 'rust-toolchain.toml']) {
    if (!provenance.inputs?.[required]) throw new Error(`Missing locked build input: ${required}`)
  }
  const identity = packageIdentity(artifact)
  if (identity.version !== debianVersion(provenance.sourceVersion) || identity.version !== provenance.version) throw new Error('Debian version/provenance mismatch')
  return { directory, provenance, provenanceBytes: bytes, identity }
}
