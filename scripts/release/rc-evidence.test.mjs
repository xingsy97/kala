import assert from 'node:assert/strict'
import { createRcEvidence, requiredReleaseEvidence, validateRcEvidence, verifyRcEvidenceSet } from './rc-evidence.mjs'
import test from 'node:test'

const revision = 'a'.repeat(40)
const tag = 'v0.2.0-rc.1'

test('accepts only the complete release matrix bound to one tag and revision', () => {
  const records = Object.entries(requiredReleaseEvidence).flatMap(([category, policy]) => policy.targets.map((target) => create(category, target)))
  assert.equal(verifyRcEvidenceSet(records, { tag, revision }).length, 8)
})

test('rejects missing checks, duplicate targets, and mismatched revisions', () => {
  const portable = create('portable', 'linux-x64')
  assert.throws(() => validateRcEvidence({ ...portable, checks: { ...portable.checks, upgrade: false } }), /did not prove upgrade/u)
  assert.throws(() => verifyRcEvidenceSet([portable, portable], { tag, revision }), /duplicate/u)
  assert.throws(() => validateRcEvidence(portable, { tag, revision: 'b'.repeat(40) }), /revision mismatch/u)
})

test('rejects diagnostics, private locations, URLs, and sensitive fields', () => {
  const portable = create('portable', 'linux-x64')
  assert.throws(() => validateRcEvidence({ ...portable, receipt: 'completed' }), /unknown fields/u)
  assert.throws(() => validateRcEvidence({ ...portable, artifact: { ...portable.artifact, name: '/home/example/release' } }), /artifact name/u)
  assert.throws(() => validateRcEvidence({ ...portable, checks: { ...portable.checks, endpoint: 'https://example.test' } }), /unknown fields/u)
})

function create(category, target) {
  return createRcEvidence({
    category, target, tag, version: tag.slice(1), revision, ok: true,
    artifact: { name: category + '-' + target + '.tar.gz', sha256: 'b'.repeat(64) },
    checks: Object.fromEntries(requiredReleaseEvidence[category].checks.map((name) => [name, true])),
    generatedAt: '2026-08-21T00:00:00.000Z',
  })
}
