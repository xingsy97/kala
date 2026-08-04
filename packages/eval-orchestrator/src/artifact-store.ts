import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { ArtifactEntry, ReportFormat, ReportManifest } from '@agent-kernel/eval-protocol'

import { dataDirectoryForArtifacts, withDataDirectoryLock } from './data-directory-lock.js'

export type StoredArtifact = { path: string; mediaType: string; bytes: number; sha256: string; content: Buffer }

export class ContainedArtifactStore {
  readonly root: string
  constructor(root: string) { this.root = resolve(root) }

  async initialize(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }) }

  async readEntry(entry: Pick<ArtifactEntry, 'path' | 'mediaType' | 'bytes' | 'sha256'>): Promise<StoredArtifact> {
    return this.readVerified(entry.path, entry.mediaType, entry.bytes, entry.sha256)
  }

  async readReport(manifest: ReportManifest, format: ReportFormat): Promise<StoredArtifact> {
    const entry = manifest.formats.find((candidate) => candidate.format === format)
    if (!entry) throw new Error('unknown report format: ' + format)
    return this.readVerified(entry.path, mediaTypeForReport(format), undefined, entry.sha256)
  }

  async readRegisteredFile(file: { path: string; mediaType: string; bytes: number; sha256: string }): Promise<StoredArtifact> { return this.readVerified(file.path, file.mediaType, file.bytes, file.sha256) }

  async writeExclusive(path: string, content: Uint8Array, expectedSha256: string): Promise<void> {
    await withDataDirectoryLock(dataDirectoryForArtifacts(this.root), async () => {
      const destination = this.containedPath(path)
      const actual = createHash('sha256').update(content).digest('hex')
      if (actual !== expectedSha256) throw new Error('generated artifact hash mismatch: ' + path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const temporary = destination + '.upload-' + randomUUID()
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(content); await handle.sync(); await handle.close(); handle = undefined
        await link(temporary, destination)
      } finally {
        await handle?.close().catch(() => undefined)
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    })
  }

  async writeIdempotent(path: string, content: Uint8Array, expectedSha256: string): Promise<void> {
    try {
      await this.writeExclusive(path, content, expectedSha256)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await this.readVerified(path, 'application/octet-stream', content.byteLength, expectedSha256)
      if (!existing.content.equals(Buffer.from(content))) throw new Error('conflicting artifact upload: ' + path)
    }
  }

  async deleteFiles(paths: readonly string[]): Promise<void> {
    await withDataDirectoryLock(dataDirectoryForArtifacts(this.root), async () => {
      for (const path of [...new Set(paths)].sort()) {
        const target = this.containedPath(path)
        try {
          const metadata = await lstat(target)
          if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('deletion target must be a regular non-symlink file')
          const canonical = await realpath(target)
          const canonicalRoot = await realpath(this.root)
          if (!contained(canonicalRoot, canonical)) throw new Error('deletion target resolved outside configured root')
          await rm(canonical)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    })
  }

  private async readVerified(path: string, mediaType: string, expectedBytes: number | undefined, expectedSha256: string): Promise<StoredArtifact> {
    const target = this.containedPath(path)
    const root = await realpath(this.root)
    const metadata = await lstat(target)
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('artifact must be a regular non-symlink file')
    const canonical = await realpath(target)
    if (!contained(root, canonical)) throw new Error('artifact resolved outside configured root')
    const content = await readFile(canonical)
    if (expectedBytes !== undefined && content.byteLength !== expectedBytes) throw new Error('artifact size mismatch: ' + path)
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (sha256 !== expectedSha256) throw new Error('artifact integrity mismatch: ' + path)
    return { path, mediaType, bytes: content.byteLength, sha256, content }
  }

  private containedPath(path: string): string {
    if (!path || isAbsolute(path) || path.split(/[\\/]/u).some((part) => part === '..')) throw new Error('artifact path must be contained and relative')
    const target = resolve(this.root, path)
    if (!contained(this.root, target)) throw new Error('artifact path escaped configured root')
    return target
  }
}

function contained(root: string, target: string): boolean { const path = relative(root, target); return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path) }
function mediaTypeForReport(format: ReportFormat): string {
  switch (format) {
    case 'json': return 'application/json'
    case 'csv': return 'text/csv; charset=utf-8'
    case 'html': return 'text/html; charset=utf-8'
    case 'pdf': return 'application/pdf'
    case 'junit': return 'application/junit+xml'
    case 'sarif': return 'application/sarif+json'
    case 'markdown': return 'text/markdown; charset=utf-8'
  }
}
