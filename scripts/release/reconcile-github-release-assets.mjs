#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const tag = required('--tag')
const directory = resolve(required('--directory'))
const entries = readdirSync(directory, { withFileTypes: true })
if (entries.length === 0) fail('local release inventory is empty')
if (entries.some((entry) => !entry.isFile())) fail('local release inventory contains a non-file')
const expected = entries.map((entry) => entry.name).sort()
assertUnique(expected, 'local release inventory')

for (const name of remoteAssetNames()) {
  if (!expected.includes(name)) run(['release', 'delete-asset', tag, name, '--yes'])
}
run(['release', 'upload', tag, ...expected.map((name) => join(directory, name)), '--clobber'])

const actual = remoteAssetNames().sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  fail(`GitHub release asset inventory mismatch; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
}
console.log(`reconciled ${expected.length} release assets for ${tag}`)

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
