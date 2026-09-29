#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const required = ['release/SHA256SUMS', 'release/manifest.json', 'pnpm-lock.yaml']
const failures = required.filter((path) => !existsSync(path)).map((path) => `missing ${path}`)
const lock = readFileSync('pnpm-lock.yaml', 'utf8')
if (!lock.includes('lockfileVersion:')) failures.push('invalid pnpm lockfile')
const workspace = readFileSync('pnpm-workspace.yaml', 'utf8')
if (!/^minimumReleaseAge:\s+1440$/mu.test(workspace)) failures.push('pnpm minimumReleaseAge must be fixed at 1440 minutes')
if (!/^saveExact:\s+true$/mu.test(workspace)) failures.push('pnpm saveExact must be enabled')
const manifests = spawnSync('git', ['ls-files', '-z', '--', 'package.json', '**/package.json'], { encoding: 'utf8' })
if (manifests.status !== 0) {
  failures.push('unable to enumerate tracked package manifests')
} else {
  const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
  const localReference = /^(?:workspace:|file:|link:)/u
  for (const path of manifests.stdout.split('\0').filter(Boolean)) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (typeof version !== 'string' || (!exactVersion.test(version) && !localReference.test(version))) {
          failures.push(`${path} ${field}.${name} must use an exact version or local workspace reference`)
        }
      }
    }
  }
}
const strict = process.argv.includes('--strict')
for (const binary of ['syft', 'grype', 'trivy', 'cosign']) {
  const available = spawnSync('sh', ['-lc', `command -v ${binary}`]).status === 0
  if (strict && !available) failures.push(`missing security tool ${binary}`)
  else process.stdout.write(`${available ? 'PASS' : 'SKIP'} ${binary}\n`)
}
const privacy = spawnSync(process.execPath, ['scripts/security/privacy-check.mjs', '--repository'], { encoding: 'utf8' })
if (privacy.status !== 0) failures.push('privacy gate rejected the repository snapshot; run pnpm privacy:check for redacted diagnostics')
if (failures.length) { for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`); process.exit(1) }
process.stdout.write('PASS supply-chain release gate\n')
