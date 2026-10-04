#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const tag = required('--tag')
const directory = resolve(required('--directory'))
const preservePrivateCloudAssets = process.argv.includes('--preserve-private-cloud-assets')
const entries = readdirSync(directory, { withFileTypes: true })
if (entries.length === 0) fail('local release inventory is empty')
if (entries.some((entry) => !entry.isFile())) fail('local release inventory contains a non-file')
const expected = entries.map((entry) => entry.name).sort()
assertUnique(expected, 'local release inventory')
const owned = new Set(expected)
const preserved = preservePrivateCloudAssets ? privateCloudAssetNames(tag) : new Set()

for (const name of remoteAssetNames()) {
  if (!owned.has(name) && !preserved.has(name)) run(['release', 'delete-asset', tag, name, '--yes'])
}
run(['release', 'upload', tag, ...expected.map((name) => join(directory, name)), '--clobber'])

const actual = remoteAssetNames().sort()
const missing = expected.filter((name) => !actual.includes(name))
const unowned = actual.filter((name) => !owned.has(name) && !preserved.has(name))
if (missing.length > 0 || unowned.length > 0) {
  fail(`GitHub release asset ownership mismatch; missing local assets ${JSON.stringify(missing)}, unowned remote assets ${JSON.stringify(unowned)}`)
}
const preservedCount = actual.filter((name) => preserved.has(name)).length
console.log(`reconciled ${expected.length} release assets and preserved ${preservedCount} Private Cloud assets for ${tag}`)

function privateCloudAssetNames(releaseTag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(releaseTag)
  if (!match) fail(`cannot derive Private Cloud asset names from invalid release tag ${releaseTag}`)
  const version = match[1]
  return new Set(['linux-x64', 'linux-arm64'].flatMap((target) => [
    `kala-private-cloud-${version}-${target}.tar.gz`,
    `private-cloud-${target}.sigstore.json`,
  ]))
}

function remoteAssetNames() {
  const value = JSON.parse(run(['release', 'view', tag, '--json', 'assets']))
  if (!Array.isArray(value.assets)) fail('GitHub release assets response is invalid')
  const names = value.assets.map((asset) => asset?.name)
  if (names.some((name) => typeof name !== 'string' || name.length === 0)) fail('GitHub release contains an invalid asset name')
  assertUnique(names, 'GitHub release assets')
  return names
}

function run(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) fail(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}
function assertUnique(values, label) { if (new Set(values).size !== values.length) fail(`${label} contains duplicate names`) }
function required(name) { const index = process.argv.indexOf(name); const value = index < 0 ? undefined : process.argv[index + 1]; if (!value) fail(`missing ${name}`); return value }
function fail(message) { console.error(`FAIL ${message}`); process.exit(1) }
