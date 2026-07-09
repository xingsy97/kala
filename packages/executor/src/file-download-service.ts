import { open, readFile, stat } from 'node:fs/promises'

import type { FileContentsResult } from '@agent-kernel/shared'

export const FILE_PREVIEW_DEFAULT_MAX_BYTES = 1024 * 1024
export const FILE_PREVIEW_HARD_CEILING = 1024 * 1024
export const FILE_DOWNLOAD_HARD_CEILING = 100 * 1024 * 1024

const FILE_BINARY_PROBE_BYTES = 8192
const IMAGE_MEDIA_TYPES = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
])
const VIEWABLE_BINARY_MEDIA_TYPES = new Map<string, string>([
  ['.pdf', 'application/pdf'],
])

export type WorkspaceFileReadRequest = {
  requestId: string
  workspaceId: string
  requestedPath: string
  resolvedPath: string
  maxBytes?: number
  download?: boolean
}

export async function buildWorkspaceFileContents(
  request: WorkspaceFileReadRequest,
): Promise<FileContentsResult> {
  const base = {
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    path: request.requestedPath,
  }
  const cap = workspaceFileReadCap(request)
  try {
    const info = await stat(request.resolvedPath)
    if (!info.isFile()) {
      return { ...base, error: 'ENOTFILE: not a regular file' }
    }
    const imageMediaType = mediaTypeFor(request.resolvedPath, IMAGE_MEDIA_TYPES)
    if (imageMediaType) {
      if (info.size > cap) return tooLarge(base, info.size, cap, 'image')
      const content = (await readFile(request.resolvedPath)).toString('base64')
      return { ...base, content, size: info.size, kind: 'image', encoding: 'base64', mediaType: imageMediaType }
    }
    const viewableBinaryMediaType = mediaTypeFor(request.resolvedPath, VIEWABLE_BINARY_MEDIA_TYPES)
    if (viewableBinaryMediaType) {
      if (info.size > cap) return tooLarge(base, info.size, cap, 'file')
      const content = (await readFile(request.resolvedPath)).toString('base64')
      return { ...base, content, size: info.size, kind: 'pdf', encoding: 'base64', mediaType: viewableBinaryMediaType }
    }
    const probe = await readPrefix(request.resolvedPath, Math.min(FILE_BINARY_PROBE_BYTES, info.size))
    if (looksBinary(probe)) {
      if (!request.download) return { ...base, size: info.size, kind: 'binary', error: 'EBINARY: file appears to be binary' }
      if (info.size > cap) return tooLarge(base, info.size, cap, 'binary file')
      const content = (await readFile(request.resolvedPath)).toString('base64')
      return { ...base, content, size: info.size, kind: 'binary', encoding: 'base64', mediaType: 'application/octet-stream' }
    }
    if (info.size > cap) {
      const content = (await readPrefix(request.resolvedPath, cap)).toString('utf8')
      return { ...base, content, size: info.size, kind: 'too_large', truncated: true, error: `EFBIG: file is ${info.size} bytes (limit ${cap})` }
    }
    const content = await readFile(request.resolvedPath, 'utf8')
    return { ...base, content, size: info.size, kind: 'text' }
  } catch (err) {
    return { ...base, kind: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

export function workspaceFileReadCap(request: { maxBytes?: number; download?: boolean }): number {
  const hardCeiling = request.download ? FILE_DOWNLOAD_HARD_CEILING : FILE_PREVIEW_HARD_CEILING
  return Math.max(1, Math.min(hardCeiling, request.maxBytes ?? FILE_PREVIEW_DEFAULT_MAX_BYTES))
}

export function downloadFilename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? 'download'
}

function mediaTypeFor(path: string, mediaTypes: ReadonlyMap<string, string>): string | undefined {
  const lower = path.toLowerCase()
  for (const [ext, mediaType] of mediaTypes) {
    if (lower.endsWith(ext)) return mediaType
  }
  return undefined
}

function tooLarge(
  base: { requestId: string; workspaceId: string; path: string },
  size: number,
  cap: number,
  label: string,
): FileContentsResult {
  return { ...base, size, kind: 'too_large', truncated: true, error: `EFBIG: ${label} is ${size} bytes (limit ${cap})` }
}

async function readPrefix(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  let suspicious = 0
  for (const byte of buffer) {
    if (byte === 0) return true
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1
  }
  return suspicious / buffer.length > 0.08
}
