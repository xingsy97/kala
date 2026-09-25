import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const dashboardArchiveName = 'kala-dashboard.tar.gz'
export const dashboardManifestName = 'dashboard-release.json'
export const releaseMetadataArchiveName = 'kala-release-metadata.tar.gz'
export const releaseMetadataFiles = Object.freeze(['sbom.cdx.json', 'THIRD_PARTY_NOTICES.txt', 'RELEASE_NOTES.md'])

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function createDashboardArchive({ dashboardDist, manifestPath, outputPath }) {
  const manifestBytes = readFileSync(manifestPath)
  const manifest = parseDashboardManifest(manifestBytes)
  const diskFiles = walkRegularFiles(dashboardDist)
  const expected = manifest.files.map((entry) => entry.path).sort()
  const actual = diskFiles.map((path) => relative(dashboardDist, path).replaceAll('\\', '/')).sort()
  if (!sameNames(actual, expected)) throw new Error('Dashboard dist file set does not exactly match dashboard-release.json')
  for (const entry of manifest.files) {
    const bytes = readFileSync(join(dashboardDist, ...entry.path.split('/')))
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Dashboard file does not match manifest: ${entry.path}`)
  }
  return createArchive(outputPath, [
    ...manifest.files.map((entry) => ({ name: entry.path, source: join(dashboardDist, ...entry.path.split('/')) })),
    { name: dashboardManifestName, bytes: manifestBytes },
  ])
}

export function createReleaseMetadataArchive({ releaseDir, outputPath = join(releaseDir, releaseMetadataArchiveName) }) {
  return createArchive(outputPath, releaseMetadataFiles.map((name) => ({ name, source: join(releaseDir, name) })))
}

export function verifyDashboardArchive(archivePath, options = {}) {
  const entries = readExactTarGz(archivePath, options)
  const manifestBytes = entries.get(dashboardManifestName)
  if (!manifestBytes) throw new Error(`Dashboard archive is missing ${dashboardManifestName}`)
  const manifest = parseDashboardManifest(manifestBytes)
  const expected = [...manifest.files.map((entry) => entry.path), dashboardManifestName].sort()
  if (!sameNames([...entries.keys()].sort(), expected)) throw new Error('Dashboard archive file set does not exactly match its embedded manifest')
  for (const entry of manifest.files) {
    const bytes = entries.get(entry.path)
    if (!bytes || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Dashboard archive file does not match manifest: ${entry.path}`)
  }
  return { manifest, manifestBytes, manifestSha256: sha256(manifestBytes), archiveSha256: sha256(readFileSync(archivePath)) }
}

export function verifyReleaseMetadataArchive(archivePath, { version, ...options } = {}) {
  const entries = readExactTarGz(archivePath, options)
  if (!sameNames([...entries.keys()].sort(), [...releaseMetadataFiles].sort())) throw new Error('Release metadata archive must contain exactly the SBOM, notices, and release notes')
  const sbom = parseJson(entries.get('sbom.cdx.json'), 'SBOM')
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.6' || !Array.isArray(sbom.components) || sbom.components.length === 0) throw new Error('Release metadata archive contains an invalid CycloneDX SBOM')
  if (version && sbom.metadata?.component?.version !== version) throw new Error('Release metadata SBOM version does not match the release')
  if (sbom.components.some((component) => component.licenses?.some((entry) => entry.license?.id === 'Unknown'))) throw new Error('Release metadata SBOM contains an unknown license')
  const notices = entries.get('THIRD_PARTY_NOTICES.txt').toString('utf8')
  if (!notices.includes('third-party dependency inventory')) throw new Error('Release metadata archive contains invalid third-party notices')
  if (version && !notices.includes(`Kala ${version}`)) throw new Error('Release metadata notices version does not match the release')
  if (entries.get('RELEASE_NOTES.md').length === 0) throw new Error('Release metadata archive contains empty release notes')
  return entries
}

export function extractReleaseMetadataArchive(archivePath, outputDir, options = {}) {
  const entries = verifyReleaseMetadataArchive(archivePath, options)
  mkdirSync(outputDir, { recursive: true })
  if (readdirSync(outputDir).length !== 0) throw new Error('Release metadata extraction directory must be empty')
  for (const name of releaseMetadataFiles) writeFileSync(join(outputDir, name), entries.get(name), { flag: 'wx', mode: 0o600 })
}

export function readExactTarGz(archivePath, { maxUncompressedBytes = 512 * 1024 * 1024 } = {}) {
  const compressed = readFileSync(archivePath)
  let tar
  try { tar = gunzipSync(compressed, { maxOutputLength: maxUncompressedBytes }) } catch (error) { throw new Error(`Cannot decompress release archive: ${error.message}`) }
  const entries = new Map()
  let offset = 0
  let ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512
    if (header.every((byte) => byte === 0)) { ended = true; break }
    verifyTarChecksum(header)
    const name = tarString(header.subarray(0, 100))
    const prefix = tarString(header.subarray(345, 500))
    const path = prefix ? `${prefix}/${name}` : name
    assertSafeArchivePath(path)
    const type = header[156]
    if (type !== 0 && type !== 48) throw new Error(`Release archive contains a non-regular entry: ${path}`)
    const size = tarNumber(header.subarray(124, 136), `size for ${path}`)
    if (size > maxUncompressedBytes || offset + size > tar.length) throw new Error(`Release archive entry is truncated or too large: ${path}`)
    if (entries.has(path)) throw new Error(`Release archive contains a duplicate entry: ${path}`)
    entries.set(path, Buffer.from(tar.subarray(offset, offset + size)))
    offset += Math.ceil(size / 512) * 512
  }
  if (!ended || tar.subarray(offset).some((byte) => byte !== 0)) throw new Error('Release archive has an invalid tar terminator')
  return entries
}

function createArchive(outputPath, entries) {
  const names = entries.map((entry) => entry.name)
  for (const name of names) assertSafeArchivePath(name)
  if (new Set(names).size !== names.length) throw new Error('Cannot create an archive with duplicate entries')
  const staging = mkdtempSync(join(tmpdir(), 'kala-release-archive-'))
  const temporary = `${outputPath}.tmp-${process.pid}-${Date.now()}`
  try {
    for (const entry of entries) {
      const target = join(staging, ...entry.name.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      if (entry.source) {
        if (!lstatSync(entry.source).isFile()) throw new Error(`Archive source is not a regular file: ${entry.name}`)
        copyFileSync(entry.source, target)
      } else writeFileSync(target, entry.bytes)
    }
    mkdirSync(dirname(outputPath), { recursive: true })
    const result = spawnSync('tar', ['--format=ustar', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '-czf', temporary, '-C', staging, '--null', '-T', '-'], {
      input: Buffer.from(`${names.join('\0')}\0`), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status !== 0) throw new Error(`Cannot create release archive: ${result.stderr || result.error?.message || result.status}`)
    renameSync(temporary, outputPath)
    return outputPath
  } finally {
    rmSync(temporary, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}

function parseDashboardManifest(bytes) {
  const manifest = parseJson(bytes, 'Dashboard manifest')
  if (manifest.schemaVersion !== 1 || manifest.product !== 'kala-dashboard' || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Invalid Dashboard release manifest')
  const paths = []
  for (const entry of manifest.files) {
    assertSafeArchivePath(entry?.path)
    if (entry.path === dashboardManifestName) throw new Error(`Dashboard static files cannot shadow ${dashboardManifestName}`)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? '')) throw new Error(`Invalid Dashboard manifest entry: ${entry.path}`)
    paths.push(entry.path)
  }
  if (new Set(paths).size !== paths.length) throw new Error('Dashboard manifest contains duplicate paths')
  if (!paths.includes('index.html')) throw new Error('Dashboard manifest is missing index.html')
  const sorted = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path))
  if (manifest.assetDigest !== sha256(Buffer.from(JSON.stringify(sorted)))) throw new Error('Dashboard manifest assetDigest is invalid')
  return manifest
}

function walkRegularFiles(root) {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`Dashboard dist contains a non-regular entry: ${relative(root, path)}`)
    }
  }
  walk(root)
  return files
}

function assertSafeArchivePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.endsWith('/') || path.includes('\0')) throw new Error(`Unsafe release archive path: ${String(path)}`)
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe release archive path: ${path}`)
  const bytes = Buffer.byteLength(path)
  const split = parts.length > 1 ? [parts.slice(0, -1).join('/'), parts.at(-1)] : ['', path]
  if (bytes > 255 || Buffer.byteLength(split[0]) > 155 || Buffer.byteLength(split[1]) > 100) throw new Error(`Release archive path exceeds portable ustar limits: ${path}`)
}

function verifyTarChecksum(header) {
  const expected = tarNumber(header.subarray(148, 156), 'header checksum')
  let actual = 0
  for (let index = 0; index < header.length; index++) actual += index >= 148 && index < 156 ? 32 : header[index]
  if (actual !== expected) throw new Error('Release archive has an invalid tar header checksum')
}

function tarString(bytes) {
  const end = bytes.indexOf(0)
  const value = bytes.subarray(0, end < 0 ? bytes.length : end)
  return new TextDecoder('utf-8', { fatal: true }).decode(value)
}

function tarNumber(bytes, label) {
  if (bytes[0] & 0x80) throw new Error(`Release archive uses an unsupported base-256 ${label}`)
  const value = tarString(bytes).trim()
  if (!/^[0-7]*$/u.test(value)) throw new Error(`Release archive has an invalid ${label}`)
  const number = Number.parseInt(value || '0', 8)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Release archive has an invalid ${label}`)
  return number
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`${label} is not valid JSON`) }
}

function sameNames(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
