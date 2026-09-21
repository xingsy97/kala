#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { run, verifyBuild } from './desktop-provenance.mjs'
import { writeSignedRepository } from './desktop-apt-repository.mjs'
import { aptInstallSnippet } from '../../packages/dashboard/public/downloads/desktop/apt-snippet.js'

const [artifactArg, outputArg, ...extra] = process.argv.slice(2)
const fingerprint = process.env.RUNLAB_APT_SIGNING_FINGERPRINT
const installation = { schemaVersion: 1, url: process.env.RUNLAB_APT_PUBLIC_URL, fingerprint }
if (!artifactArg || !outputArg || extra.length || !/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(fingerprint ?? '')) {
  throw new Error('Usage: RUNLAB_APT_SIGNING_FINGERPRINT=<existing full signing-key fingerprint> node scripts/release/publish-desktop-apt.mjs <locally-built-deb> <new-output-directory>. No key is generated.')
}
const artifact = resolve(artifactArg)
const output = resolve(outputArg)
const snippet = aptInstallSnippet(installation)
if (existsSync(output)) throw new Error('Output must be a new directory')
const { directory: buildRecord, provenance } = verifyBuild(artifact)
// Neither a supplied manifest nor the current checkout can authorize signing.
run('cargo-audit', ['audit', '--file', resolve(buildRecord, 'Cargo.lock'), '--deny', 'unsound'])
run('pnpm', ['audit', '--lockfile-dir', buildRecord, '--audit-level', 'low'])
verifyBuild(artifact)
writeSignedRepository(artifact, output, fingerprint, 'Kala', provenance.artifact.sha256)
writeFileSync(resolve(output, 'apt-install.json'), `${JSON.stringify(installation, null, 2)}\n`)
writeFileSync(resolve(output, 'install-desktop.txt'), `${snippet}\n`)
console.log(`Signed staging repository: ${output}\nSigning fingerprint: ${fingerprint}\nPublish over operator-controlled HTTPS only after independently verifying the fingerprint and testing apt update/install/upgrade.`)
