import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
test('blocks high findings and accepts only exact unexpired exceptions', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'runlab-vulnerability-policy-'))
  const grype = file(scratch, 'grype.json', { matches: [{ vulnerability: { id: 'CVE-2099-0001', severity: 'High', fix: { versions: ['2.0.0'] } }, artifact: { name: 'example', version: '1.0.0', locations: [{ path: '/public/release' }] } }] })
  const trivy = file(scratch, 'trivy.json', { Results: [{ Target: 'release', Vulnerabilities: [] }] })
  assert.notEqual(run(grype, trivy, file(scratch, 'none.json', { schemaVersion: 1, exceptions: [] })).status, 0)
  const exact = { scanner: 'grype', vulnerabilityId: 'CVE-2099-0001', package: 'example', installedVersion: '1.0.0', trackingUrl: 'https://example.invalid/issues/1', owner: 'security-owner', rationale: 'Synthetic test fixture.', expiresOn: '2099-12-31' }
  assert.equal(run(grype, trivy, file(scratch, 'exact.json', { schemaVersion: 1, exceptions: [exact] })).status, 0)
  assert.notEqual(run(grype, trivy, file(scratch, 'wrong.json', { schemaVersion: 1, exceptions: [{ ...exact, installedVersion: '1.0.1' }] })).status, 0)
  assert.notEqual(run(grype, trivy, file(scratch, 'expired.json', { schemaVersion: 1, exceptions: [{ ...exact, expiresOn: '2020-01-01' }] })).status, 0)
})
function file(directory, name, value) { const path = join(directory, name); writeFileSync(path, JSON.stringify(value)); return path }
function run(grype, trivy, exceptions) { return spawnSync(process.execPath, ['scripts/security/check-vulnerabilities.mjs', '--grype', grype, '--trivy', trivy, '--exceptions', exceptions], { cwd: root, encoding: 'utf8' }) }
