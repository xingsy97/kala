#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const required = ['release/SHA256SUMS', 'release/manifest.json', 'pnpm-lock.yaml']
const failures = required.filter((path) => !existsSync(path)).map((path) => `missing ${path}`)
const lock = readFileSync('pnpm-lock.yaml', 'utf8')
if (!lock.includes('lockfileVersion:')) failures.push('invalid pnpm lockfile')
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
