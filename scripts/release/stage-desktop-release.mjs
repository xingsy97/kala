#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { sha, verifyBuild } from './desktop-provenance.mjs'

export function stage(artifact, output, registry) {
  artifact = resolve(artifact)
  output = resolve(output)
  const { provenance, provenanceBytes } = verifyBuild(artifact, registry)
  const artifactBytes = readFileSync(artifact)
  if (sha(artifactBytes) !== provenance.artifact.sha256) throw new Error('Artifact changed during staging')
  const file = basename(artifact)
  if (!/^[A-Za-z0-9][A-Za-z0-9._+~-]*\.deb$/.test(file)) throw new Error('Unsafe package filename')
  const prefix = `${provenance.version}-${provenance.artifact.sha256}`
  const dependencies = `${prefix}.dependencies.json`
  const checksumFile = `${prefix}.SHA256SUMS.txt`
  const checksumBytes = `${provenance.artifact.sha256}  ${file}\n${sha(provenanceBytes)}  ${dependencies}\n`
  const manifest = {
    schemaVersion: 2, version: provenance.version, platform: 'linux-amd64',
    artifact: provenance.artifact,
    dependencies: { file: dependencies, sha256: sha(provenanceBytes) },
    checksums: { file: checksumFile, sha256: sha(checksumBytes) },
    signature: provenance.signature, security: provenance.security,
  }
  mkdirSync(output, { recursive: true })
  // Immutable objects are never replaced, even when a prior version remains cached.
  for (const [name, bytes] of [[file, artifactBytes], [dependencies, provenanceBytes], [checksumFile, checksumBytes], [`${prefix}.release.json`, `${JSON.stringify(manifest, null, 2)}\n`]]) {
    const target = resolve(output, name)
    if (existsSync(target)) {
      if (sha(readFileSync(target)) !== sha(bytes)) throw new Error(`Immutable release collision: ${name}`)
    } else writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 })
  }
  const pending = resolve(output, `release.json.incoming-${randomUUID()}`)
  writeFileSync(pending, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  renameSync(pending, resolve(output, 'release.json'))
  return manifest
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [artifact, output, ...extra] = process.argv.slice(2)
  if (!artifact || !output || extra.length) throw new Error('Usage: node scripts/release/stage-desktop-release.mjs <locally-built-deb> <output-directory>')
  console.log(JSON.stringify(stage(artifact, output), null, 2))
}
