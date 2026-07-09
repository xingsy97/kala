import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  FILE_DOWNLOAD_HARD_CEILING,
  FILE_PREVIEW_DEFAULT_MAX_BYTES,
  buildWorkspaceFileContents,
  downloadFilename,
  workspaceFileReadCap,
} from './file-download-service.js'

describe('file download service', () => {
  let root: string

  beforeEach(() => {
    root = join(tmpdir(), `ak-file-download-${randomUUID()}`)
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('caps preview and download reads independently', () => {
    expect(workspaceFileReadCap({})).toBe(FILE_PREVIEW_DEFAULT_MAX_BYTES)
    expect(workspaceFileReadCap({ maxBytes: 50 })).toBe(50)
    expect(workspaceFileReadCap({ maxBytes: 1024 * 1024 * 1024 })).toBe(FILE_PREVIEW_DEFAULT_MAX_BYTES)
    expect(workspaceFileReadCap({ download: true, maxBytes: 1024 * 1024 * 1024 })).toBe(FILE_DOWNLOAD_HARD_CEILING)
    expect(workspaceFileReadCap({ maxBytes: -1 })).toBe(1)
  })

  it('does not include binary content in previews but includes it for downloads', async () => {
    const path = join(root, 'archive.bin')
    const bytes = Buffer.from([0, 1, 2, 3])
    writeFileSync(path, bytes)

    const preview = await buildWorkspaceFileContents(base({ path }))
    expect(preview.kind).toBe('binary')
    expect(preview.content).toBeUndefined()

    const download = await buildWorkspaceFileContents(base({ path, download: true }))
    expect(download.kind).toBe('binary')
    expect(download.encoding).toBe('base64')
    expect(download.mediaType).toBe('application/octet-stream')
    expect(download.content).toBe(bytes.toString('base64'))
  })

  it('returns image and PDF files as typed base64 payloads', async () => {
    const image = join(root, 'image.PNG')
    const pdf = join(root, 'report.pdf')
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(pdf, Buffer.from('%PDF-1.7\n\0'))

    const imageResult = await buildWorkspaceFileContents(base({ path: image }))
    expect(imageResult.kind).toBe('image')
    expect(imageResult.mediaType).toBe('image/png')

    const pdfResult = await buildWorkspaceFileContents(base({ path: pdf }))
    expect(pdfResult.kind).toBe('pdf')
    expect(pdfResult.mediaType).toBe('application/pdf')
  })

  it('returns safe download filenames from paths', () => {
    expect(downloadFilename('/repo/archive.tar.gz')).toBe('archive.tar.gz')
    expect(downloadFilename('C:\\repo\\notes.txt')).toBe('notes.txt')
    expect(downloadFilename('/')).toBe('download')
  })
})

function base(options: { path: string; download?: boolean }) {
  return {
    requestId: 'r1',
    workspaceId: 'w1',
    requestedPath: options.path,
    resolvedPath: options.path,
    download: options.download,
  }
}
