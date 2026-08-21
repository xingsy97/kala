#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const metadata = { repository: { type: 'git', url: 'git+https://github.com/xingsy97/akernel.git' }, homepage: 'https://github.com/xingsy97/akernel#readme', bugs: { url: 'https://github.com/xingsy97/akernel/issues' } }
const failures = []
const packages = workspacePackages().filter(({ manifest }) => manifest.private !== true)
for (const item of packages) {
  const { manifest, directory } = item
  for (const field of ['name', 'version', 'description', 'license']) if (typeof manifest[field] !== 'string' || !manifest[field].trim()) failures.push(`${manifest.name ?? directory} missing ${field}`)
  if (JSON.stringify(manifest.repository) !== JSON.stringify(metadata.repository) || manifest.homepage !== metadata.homepage || manifest.bugs?.url !== metadata.bugs.url) failures.push(`${manifest.name} has incomplete public repository metadata`)
  if (!existsSync(join(directory, 'README.md')) || !Array.isArray(manifest.files) || !manifest.files.includes('README.md')) failures.push(`${manifest.name} does not ship README.md`)
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: directory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (packed.status !== 0) { failures.push(`${manifest.name} npm pack failed`); continue }
  let files; try { files = new Set(JSON.parse(packed.stdout)[0].files.map((entry) => entry.path)) } catch { failures.push(`${manifest.name} emitted invalid npm pack metadata`); continue }
  for (const required of ['package.json', 'README.md']) if (!files.has(required)) failures.push(`${manifest.name} packed tarball is missing ${required}`)
  for (const target of exportTargets(manifest.exports)) if (!files.has(stripDotSlash(target))) failures.push(`${manifest.name} packed tarball is missing export ${target}`)
  for (const target of Object.values(manifest.bin ?? {})) if (!files.has(stripDotSlash(String(target)))) failures.push(`${manifest.name} packed tarball is missing bin ${target}`)
}
if (failures.length) { for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`); process.exit(1) }
process.stdout.write(`PASS public package metadata and tarballs (${String(packages.length)} workspaces)\n`)

function workspacePackages() {
  const result = []
  for (const parent of ['packages', 'adapters/agents', 'adapters/benchmarks', 'adapters/environments']) for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; const path = join(root, parent, entry.name, 'package.json'); if (!existsSync(path)) continue
    result.push({ directory: dirname(path), manifest: JSON.parse(readFileSync(path, 'utf8')) })
  }
  return result
}
function exportTargets(exports) {
  const targets = []
  const visit = (value) => { if (typeof value === 'string') targets.push(value); else if (value && typeof value === 'object') for (const nested of Object.values(value)) visit(nested) }
  visit(exports); return targets
}
function stripDotSlash(value) { return value.startsWith('./') ? value.slice(2) : value }
