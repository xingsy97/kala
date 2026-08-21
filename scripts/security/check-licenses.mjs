#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const allowed = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Unlicense',
  '(MIT OR CC0-1.0)',
  '(MPL-2.0 OR Apache-2.0)',
])

const reviewedUnknown = new Map([
  ['khroma@2.1.0', {
    licenseFile: 'license',
    sha256: '66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49',
    classification: 'MIT',
  }],
])

const result = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
if (result.status !== 0) fail('pnpm license inventory failed')
const inventory = JSON.parse(result.stdout)
const failures = []
for (const [license, packages] of Object.entries(inventory)) {
  if (license !== 'Unknown' && !allowed.has(license)) {
    for (const entry of packages) failures.push(`${entry.name}@${entry.versions.join(',')}: disallowed or unreviewed license ${license}`)
    continue
  }
  if (license !== 'Unknown') continue
  for (const entry of packages) {
    for (const version of entry.versions) {
      const key = `${entry.name}@${version}`
      const review = reviewedUnknown.get(key)
      const packageRoot = entry.paths.find((path) => path.includes(`/node_modules/${entry.name}`)) ?? entry.paths[0]
      if (!review || !packageRoot) { failures.push(`${key}: unknown license has no exact review`); continue }
      const bytes = readFileSync(`${packageRoot}/${review.licenseFile}`)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== review.sha256) failures.push(`${key}: reviewed license text changed`)
    }
  }
}
if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`PASS production dependency license gate (${Object.keys(inventory).length} license classes)\n`)

function fail(message) { process.stderr.write(`FAIL ${message}\n`); process.exit(1) }
