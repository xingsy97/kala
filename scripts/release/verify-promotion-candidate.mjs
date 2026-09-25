#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { collectRcEvidence, requiredReleaseEvidence, verifyRcEvidenceSet } from './rc-evidence.mjs'
import { verifyReleaseChecksums } from './release-checksums.mjs'

const directory = resolve(required('--directory'))
const evidenceDirectory = resolve(required('--evidence'))
const aggregatePath = resolve(required('--aggregate'))
const tag = required('--tag')
const revision = required('--revision')
const manifest = json(join(directory, 'manifest.json'))

if (manifest.version !== tag.slice(1)) fail('current release manifest version does not match the promoted tag')
if (manifest.source?.revision !== revision) fail('current release manifest revision does not match the promoted revision')
if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) fail('current release manifest has no assets')
assertUnique(manifest.assets, 'current release manifest assets')
const targets = [...requiredReleaseEvidence.portable.targets]
if (!Array.isArray(manifest.nativeTargets) || JSON.stringify([...manifest.nativeTargets].sort()) !== JSON.stringify([...targets].sort())) {
  fail('current release manifest does not contain exactly the four supported native targets')
}

const aggregateName = basename(aggregatePath)
if (aggregateName !== 'rc-evidence.json') fail('aggregate evidence must be named rc-evidence.json')
const expectedFiles = [...manifest.assets, 'manifest.json', 'RELEASE_NOTES.md', 'SHA256SUMS', 'SHA256SUMS.sigstore.json', aggregateName].sort()
assertUnique(expectedFiles, 'promotion release inventory')
const entries = readdirSync(directory, { withFileTypes: true })
if (entries.some((entry) => !entry.isFile())) fail('current release inventory contains a non-file')
const actualFiles = entries.map((entry) => entry.name).sort()
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  fail(`current release inventory is not closed; expected ${JSON.stringify(expectedFiles)}, received ${JSON.stringify(actualFiles)}`)
}
if (digest(readFileSync(join(directory, aggregateName))) !== digest(readFileSync(aggregatePath))) {
  fail('uploaded aggregate evidence differs from the validated local record')
}

await verifyReleaseChecksums(directory, [...manifest.assets, 'manifest.json', 'RELEASE_NOTES.md'])
const evidence = verifyRcEvidenceSet(collectRcEvidence(evidenceDirectory), { tag, revision })
for (const target of targets) {
  const record = evidence.find((entry) => entry.category === 'portable' && entry.target === target)
  const name = `agent-kernel-host-${target}`
  if (!record || record.artifact.name !== name) fail(`validated ${target} evidence does not identify ${name}`)
  if (!manifest.assets.includes(name)) fail(`current release manifest is missing accepted native asset ${name}`)
  if (digest(readFileSync(join(directory, name))) !== record.artifact.sha256) {
    fail(`current release asset ${name} differs from its validated acceptance evidence`)
  }
}
console.log(`verified closed promotion candidate for ${tag} at ${revision}`)

function digest(value) { return createHash('sha256').update(value).digest('hex') }
function json(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { fail(`invalid JSON file: ${basename(path)}`) } }
function assertUnique(values, label) { if (new Set(values).size !== values.length) fail(`${label} contains duplicate names`) }
function required(name) { const index = process.argv.indexOf(name); const value = index < 0 ? undefined : process.argv[index + 1]; if (!value) fail(`missing ${name}`); return value }
function fail(message) { throw new Error(message) }
