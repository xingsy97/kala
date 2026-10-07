import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createRcEvidence, requiredReleaseEvidence } from './rc-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const script = 'scripts/release/verify-private-cloud-fresh-evidence.mjs'
const tag = 'v0.3.0-beta.1'
const revision = 'a'.repeat(40)

test('binds fresh candidate evidence to the exact accepted archive bytes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'private-cloud-fresh-evidence-'))
  const archive = join(scratch, 'kala-private-cloud-0.3.0-beta.1-linux-x64.tar.gz')
  const evidence = join(scratch, 'fresh.rc-evidence.json')
  writeFileSync(archive, 'signed draft bundle bytes')
  writeFileSync(evidence, JSON.stringify(freshEvidence(archive)))

  const accepted = verify(evidence, archive)
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(JSON.parse(accepted.stdout).target, 'linux-x64-compose-fresh')

  writeFileSync(archive, 'different bundle bytes')
  const rejected = verify(evidence, archive)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /archive digest mismatch/u)
})

test('rejects predecessor lifecycle evidence as a fresh candidate result', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'private-cloud-fresh-evidence-'))
  const archive = join(scratch, 'kala-private-cloud-0.3.0-beta.1-linux-x64.tar.gz')
  const evidence = join(scratch, 'lifecycle.rc-evidence.json')
  writeFileSync(archive, 'signed draft bundle bytes')
  writeFileSync(evidence, JSON.stringify(createRcEvidence({
    category: 'private-cloud', target: 'linux-x64-compose', tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: archive.split('/').at(-1), sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') },
    checks: Object.fromEntries(requiredReleaseEvidence['private-cloud'].checks.map((name) => [name, true])),
  })))

  const rejected = verify(evidence, archive)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /fresh Private Cloud evidence target is required/u)
})

function freshEvidence(archive) {
  const checks = requiredReleaseEvidence['private-cloud'].targetChecks['linux-x64-compose-fresh']
  return createRcEvidence({
    category: 'private-cloud', target: 'linux-x64-compose-fresh', tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: archive.split('/').at(-1), sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') },
    checks: Object.fromEntries(checks.map((name) => [name, true])),
  })
}

function verify(evidence, archive) {
  return spawnSync(process.execPath, [script, '--evidence', evidence, '--archive', archive, '--tag', tag, '--revision', revision], { cwd: root, encoding: 'utf8' })
}
