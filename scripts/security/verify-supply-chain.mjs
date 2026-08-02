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
const tracked = spawnSync('git', ['grep', '-IlE', '(AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)', '--', ':!references/**', ':!node_modules/**'], { encoding: 'utf8' })
if (tracked.status === 0 && tracked.stdout.trim()) failures.push(`possible tracked secrets:\n${tracked.stdout.trim()}`)
if (failures.length) { for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`); process.exit(1) }
process.stdout.write('PASS supply-chain release gate\n')
