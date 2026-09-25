import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createDashboardArchive,
  createReleaseMetadataArchive,
  dashboardArchiveName,
  extractReleaseMetadataArchive,
  readExactTarGz,
  releaseMetadataArchiveName,
  verifyDashboardArchive,
  verifyReleaseMetadataArchive,
} from './release-archives.mjs'

const roots = []
const temporary = (prefix) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root }
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
test.afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function dashboardFixture() {
  const root = temporary('kala-dashboard-archive-')
  const dist = join(root, 'dist'); const release = join(root, 'release')
  mkdirSync(join(dist, 'assets'), { recursive: true }); mkdirSync(release)
  writeFileSync(join(dist, 'index.html'), '<html>Dashboard</html>\n')
  writeFileSync(join(dist, 'assets', 'app.js'), 'export const ready = true\n')
  const files = [
    { path: 'assets/app.js', bytes: 26, sha256: sha256('export const ready = true\n') },
    { path: 'index.html', bytes: 23, sha256: sha256('<html>Dashboard</html>\n') },
  ]
  const manifest = { schemaVersion: 1, product: 'kala-dashboard', version: '1.2.3', assetDigest: sha256(JSON.stringify(files)), files }
  const manifestPath = join(release, 'dashboard-release.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { root, dist, release, manifestPath, archive: join(release, dashboardArchiveName) }
}

function metadataFixture() {
  const root = temporary('kala-metadata-archive-'); const release = join(root, 'release'); mkdirSync(release)
  const sbom = { bomFormat: 'CycloneDX', specVersion: '1.6', metadata: { component: { version: '1.2.3' } }, components: [{ name: 'safe', licenses: [{ license: { id: 'MIT' } }] }] }
  writeFileSync(join(release, 'sbom.cdx.json'), JSON.stringify(sbom))
  writeFileSync(join(release, 'THIRD_PARTY_NOTICES.txt'), 'Kala 1.2.3 third-party dependency inventory\n')
  writeFileSync(join(release, 'RELEASE_NOTES.md'), '# Kala 1.2.3\n')
  return { root, release, archive: join(release, releaseMetadataArchiveName) }
}

test('merges exact Dashboard bytes and its manifest into one independently verifiable archive', () => {
  const value = dashboardFixture()
  createDashboardArchive({ dashboardDist: value.dist, manifestPath: value.manifestPath, outputPath: value.archive })
  const verified = verifyDashboardArchive(value.archive)
  assert.equal(verified.manifest.version, '1.2.3')
  assert.deepEqual([...readExactTarGz(value.archive).keys()].sort(), ['assets/app.js', 'dashboard-release.json', 'index.html'])
})

test('refuses Dashboard drift and archive links before any extraction', () => {
  const value = dashboardFixture()
  writeFileSync(join(value.dist, 'index.html'), 'tampered')
  assert.throws(() => createDashboardArchive({ dashboardDist: value.dist, manifestPath: value.manifestPath, outputPath: value.archive }), /does not match manifest/u)

  const malicious = join(value.root, 'link.tar.gz')
  symlinkSync('/etc/passwd', join(value.dist, 'escape'))
  execFileSync('tar', ['-czf', malicious, '-C', value.dist, 'escape'])
  assert.throws(() => readExactTarGz(malicious), /non-regular entry/u)
})

test('packages and securely extracts the exact compliance metadata set', () => {
  const value = metadataFixture()
  createReleaseMetadataArchive({ releaseDir: value.release })
  const entries = verifyReleaseMetadataArchive(value.archive, { version: '1.2.3' })
  assert.deepEqual([...entries.keys()].sort(), ['RELEASE_NOTES.md', 'THIRD_PARTY_NOTICES.txt', 'sbom.cdx.json'])
  const extracted = join(value.root, 'extracted')
  extractReleaseMetadataArchive(value.archive, extracted, { version: '1.2.3' })
  assert.equal(readFileSync(join(extracted, 'sbom.cdx.json'), 'utf8'), readFileSync(join(value.release, 'sbom.cdx.json'), 'utf8'))
  assert.throws(() => extractReleaseMetadataArchive(value.archive, extracted), /must be empty/u)
})

test('rejects extra and duplicate members even when all required metadata is present', () => {
  const value = metadataFixture()
  writeFileSync(join(value.release, 'unexpected.txt'), 'not published')
  execFileSync('tar', ['-czf', value.archive, '-C', value.release, 'sbom.cdx.json', 'THIRD_PARTY_NOTICES.txt', 'RELEASE_NOTES.md', 'unexpected.txt'])
  assert.throws(() => verifyReleaseMetadataArchive(value.archive), /must contain exactly/u)

  execFileSync('tar', ['--hard-dereference', '-czf', value.archive, '-C', value.release, 'sbom.cdx.json', 'THIRD_PARTY_NOTICES.txt', 'RELEASE_NOTES.md', 'RELEASE_NOTES.md'])
  assert.throws(() => verifyReleaseMetadataArchive(value.archive), /duplicate entry/u)
})
