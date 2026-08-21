#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)
const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const expected = product.version
const tag = option('--tag') ?? process.env.RELEASE_TAG
const failures = []

if (!validSemver(expected)) failures.push(`invalid root product version ${expected}`)
if (tag && tag !== `v${expected}`) failures.push(`release tag ${tag} does not match product version v${expected}`)

const workspacePackages = workspacePackagePaths().map((path) => ({ path, pkg: JSON.parse(readFileSync(path, 'utf8')) }))
const workspaceByName = new Map(workspacePackages.map((item) => [item.pkg.name, item.pkg]))
for (const { pkg } of workspacePackages) {
  if (pkg.version !== expected) failures.push(`${pkg.name} is ${pkg.version}, expected ${expected}`)
  if (pkg.private !== true && pkg.license !== 'MIT') failures.push(`${pkg.name} must declare MIT or be private`)
  if (pkg.private !== true) {
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      if (workspaceByName.get(dependency)?.private === true) failures.push(`${pkg.name} publicly depends on private workspace ${dependency}`)
    }
  }
}

const manifestPath = option('--manifest')
if (manifestPath) {
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'))
  if (manifest.version !== expected) failures.push(`release manifest version ${manifest.version} does not match ${expected}`)
  if (tag && manifest.tag !== tag) failures.push(`release manifest tag ${manifest.tag} does not match ${tag}`)
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(`PASS unified product version ${expected} across ${workspacePackages.length} workspace packages\n`)

function workspacePackagePaths() {
  const paths = []
  for (const parent of ['packages', 'adapters/agents', 'adapters/benchmarks', 'adapters/environments']) {
    const absolute = join(root, parent)
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(absolute, entry.name, 'package.json'))
    }
  }
  return paths.sort()
}
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
function validSemver(value) { return /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value) }
