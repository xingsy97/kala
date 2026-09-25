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
  const trivy = file(scratch, 'trivy.json', { SchemaVersion: 2, ArtifactName: 'release', ArtifactType: 'filesystem', Results: [{ Target: 'release', Vulnerabilities: [] }] })
  assert.notEqual(run(grype, trivy, file(scratch, 'none.json', { schemaVersion: 1, exceptions: [] })).status, 0)
  const exact = { scanner: 'grype', vulnerabilityId: 'CVE-2099-0001', package: 'example', installedVersion: '1.0.0', trackingUrl: 'https://example.invalid/issues/1', owner: 'security-owner', rationale: 'Synthetic test fixture.', expiresOn: '2099-12-31' }
  assert.equal(run(grype, trivy, file(scratch, 'exact.json', { schemaVersion: 1, exceptions: [exact] })).status, 0)
  assert.notEqual(run(grype, trivy, file(scratch, 'wrong.json', { schemaVersion: 1, exceptions: [{ ...exact, installedVersion: '1.0.1' }] })).status, 0)
  assert.notEqual(run(grype, trivy, file(scratch, 'expired.json', { schemaVersion: 1, exceptions: [{ ...exact, expiresOn: '2020-01-01' }] })).status, 0)
})
test('accepts a genuine empty Trivy scan but rejects a missing or malformed scanner report', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'runlab-vulnerability-empty-'))
  const grype = file(scratch, 'grype.json', { matches: [] })
  const exceptions = file(scratch, 'none.json', { schemaVersion: 1, exceptions: [] })
  assert.equal(run(grype, file(scratch, 'empty.json', { SchemaVersion: 2, ArtifactName: 'release', ArtifactType: 'filesystem' }), exceptions).status, 0)
  assert.notEqual(run(grype, file(scratch, 'invalid.json', {}), exceptions).status, 0)
  assert.notEqual(run(grype, file(scratch, 'missing.json', { SchemaVersion: 2 }), exceptions).status, 0)
  assert.notEqual(run(grype, file(scratch, 'malformed.json', { SchemaVersion: 2, ArtifactName: 'release', ArtifactType: 'filesystem', Results: null }), exceptions).status, 0)
  const high = file(scratch, 'high.json', { SchemaVersion: 2, ArtifactName: 'release', ArtifactType: 'filesystem', Results: [{ Target: 'release', Vulnerabilities: [{ VulnerabilityID: 'CVE-2099-1000', PkgName: 'example', InstalledVersion: '1.0.0', Severity: 'HIGH' }] }] })
  assert.notEqual(run(grype, high, exceptions).status, 0)
})
function file(directory, name, value) { const path = join(directory, name); writeFileSync(path, JSON.stringify(value)); return path }
function run(grype, trivy, exceptions) { return spawnSync(process.execPath, ['scripts/security/check-vulnerabilities.mjs', '--grype', grype, '--trivy', trivy, '--exceptions', exceptions], { cwd: root, encoding: 'utf8' }) }
