#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(new URL('../..', import.meta.url).pathname)
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const tag = option('--tag')
if (tag !== `v${version}`) fail(`tag ${tag ?? '(missing)'} does not match v${version}`)
const npmTag = version.includes('-') ? 'next' : 'latest'
const dryRun = process.argv.includes('--dry-run')
const packages = workspacePackages().filter((item) => item.manifest.private !== true)
const names = new Set(packages.map((item) => item.manifest.name))
const ordered = topological(packages, names)

for (const item of ordered) {
  const identity = `${item.manifest.name}@${version}`
  if (dryRun) { process.stdout.write(`DRY-RUN ${identity} --tag ${npmTag}\n`); continue }
  const lookup = spawnSync('npm', ['view', identity, 'version', '--json'], { cwd: root, encoding: 'utf8' })
  if (lookup.status === 0 && JSON.parse(lookup.stdout) === version) {
    process.stdout.write(`SKIP ${identity} already published\n`)
    continue
  }
  if (lookup.status !== 0 && !/E404|is not in this registry/iu.test(`${lookup.stdout}\n${lookup.stderr}`)) {
    fail(`registry lookup failed for ${identity}`)
  }
  const published = spawnSync('pnpm', ['--filter', item.manifest.name, 'publish', '--access', 'public', '--tag', npmTag, '--provenance', '--no-git-checks'], { cwd: root, stdio: 'inherit' })
  if (published.status !== 0) fail(`publish failed for ${identity}`)
}
process.stdout.write(`PASS ${dryRun ? 'resolved' : 'published'} ${ordered.length} workspace packages with npm dist-tag ${npmTag}\n`)

function workspacePackages() {
  const result = []
  for (const parent of ['packages', 'adapters/agents', 'adapters/benchmarks', 'adapters/environments']) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, parent, entry.name, 'package.json')
      result.push({ path, manifest: JSON.parse(readFileSync(path, 'utf8')) })
    }
  }
  return result
}
function topological(items, workspaceNames) {
  const remaining = new Map(items.map((item) => [item.manifest.name, item]))
  const result = []
  while (remaining.size) {
    const ready = [...remaining.values()].filter((item) => Object.keys(item.manifest.dependencies ?? {}).filter((name) => workspaceNames.has(name)).every((name) => !remaining.has(name))).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
    if (!ready.length) fail(`workspace publish dependency cycle: ${[...remaining.keys()].join(', ')}`)
    for (const item of ready) { result.push(item); remaining.delete(item.manifest.name) }
  }
  return result
}
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
function fail(message) { process.stderr.write(`FAIL ${message}\n`); process.exit(1) }
