/**
 * Binary file read for dashboard previews.
 *
 * Companion to workspace-exec: reads a file from the sandbox and returns
 * base64 + a sniffed MIME. Distinct from `bash cat`-through-workspace-exec
 * because stdout is text and cannot round-trip arbitrary bytes without a
 * hex/base64 wrapper — pushing that decision into the browser is worse
 * than owning it here.
 *
 * This is the one admitted exception to "no domain knowledge in the
 * executor" in workspace-exec-refactor.md §Wire protocol: the mime sniff
 * crosses the text-vs-binary boundary, which browsers cannot straddle
 * from stdout alone.
 */

import { constants, type BigIntStats } from 'node:fs'
import { open } from 'node:fs/promises'

import type {
  WorkspaceReadBinaryRequest,
  WorkspaceReadBinaryResponse,
} from '@agent-kernel/shared/workspace-exec'

import type { Sandbox } from './sandbox.js'
import { SandboxError } from './sandbox.js'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const HARD_MAX_BYTES = 32 * 1024 * 1024
const MIME_SNIFF_MAX_BYTES = 64 * 1024

export async function workspaceReadBinary(
  req: WorkspaceReadBinaryRequest,
  sandbox: Sandbox,
): Promise<WorkspaceReadBinaryResponse> {
  const requestId = req.requestId
  const maxBytes = clampBytes(req.maxBytes)
  const offset = clampOffset(req.offset)

  let absolute: string
  try {
    absolute = await sandbox.resolve(req.path, req.cwd ? { cwd: req.cwd } : undefined)
  } catch (err) {
    if (err instanceof SandboxError) return errorResponse(requestId, 'EACCES', err.message)
    return errorResponse(requestId, 'EINVAL', err instanceof Error ? err.message : String(err))
  }

  let size: number
  let buffer: Buffer
  let mimeBuffer: Buffer
  let fileVersion: string
  try {
    // Resolve first, then open without following a replacement final symlink.
    // All metadata comes from the opened handle, avoiding path-stat races.
    const fh = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await fh.stat({ bigint: true })
      if (!before.isFile()) return errorResponse(requestId, 'EINVAL', 'not a regular file')
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) return errorResponse(requestId, 'EINVAL', 'file is too large')
      size = Number(before.size)
      if (offset > size) return errorResponse(requestId, 'EINVAL', 'offset is beyond end of file')

      const allocated = Buffer.allocUnsafe(Math.min(size - offset, maxBytes))
      const bodyRead = await fh.read(allocated, 0, allocated.length, offset)
      buffer = allocated.subarray(0, bodyRead.bytesRead)

      if (offset === 0 && buffer.length >= Math.min(size, MIME_SNIFF_MAX_BYTES)) {
        mimeBuffer = buffer.subarray(0, MIME_SNIFF_MAX_BYTES)
      } else {
        const header = Buffer.allocUnsafe(Math.min(size, MIME_SNIFF_MAX_BYTES))
        const headerRead = await fh.read(header, 0, header.length, 0)
        mimeBuffer = header.subarray(0, headerRead.bytesRead)
      }

      const after = await fh.stat({ bigint: true })
      if (!sameFileMetadata(before, after)) return errorResponse(requestId, 'EIO', 'file changed while it was being read')
      fileVersion = versionForStat(after)
    } finally {
      await fh.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return errorResponse(requestId, 'ENOENT', 'file does not exist')
    if (code === 'ELOOP') return errorResponse(requestId, 'EACCES', 'refusing to follow a replaced symbolic link')
    return errorResponse(requestId, 'EIO', err instanceof Error ? err.message : String(err))
  }

  const mime = sniffMime(mimeBuffer, req.path)
  const truncated = offset + buffer.length < size ? { maxBytes } : undefined
  return {
    requestId,
    base64: buffer.toString('base64'),
    mime,
    size,
    fileVersion,
    offset,
    ...(truncated ? { truncated } : {}),
  }
}

function sameFileMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function versionForStat(info: BigIntStats): string {
  return `v1:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

function clampBytes(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return DEFAULT_MAX_BYTES
  return Math.max(1, Math.min(HARD_MAX_BYTES, Math.floor(requested)))
}

function clampOffset(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return 0
  return Math.max(0, Math.floor(requested))
}

/**
 * Magic-byte sniff for the file formats most likely to appear in a
 * dashboard preview. Extension check is a fallback — the executor should
 * not trust the extension over the content, but many text formats have no
 * magic (.md, .json, .log) so we only reach for extension when magic is
 * inconclusive.
 */
function sniffMime(buf: Buffer, path: string): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp'
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf'
  if (looksLikeMp4(buf)) return 'video/mp4'
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'application/zip'
  if (looksLikeText(buf)) {
    const ext = path.split('.').pop()?.toLowerCase()
    if (ext === 'json') return 'application/json'
    if (ext === 'md') return 'text/markdown'
    if (ext === 'html' || ext === 'htm') return 'text/html'
    if (ext === 'css') return 'text/css'
    if (ext === 'js' || ext === 'mjs' || ext === 'ts' || ext === 'tsx' || ext === 'jsx') return 'text/javascript'
    if (ext === 'svg') return 'image/svg+xml'
    return 'text/plain'
  }
  return 'application/octet-stream'
}

// ISO-BMFF is also used by formats such as HEIF and QuickTime. Scan only a
// bounded set of legal leading boxes and require an MP4-specific ftyp brand.
const MP4_BRANDS = new Set([
  'avc1', 'dash', 'iso1', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'isom', 'M4V ', 'M4VH', 'M4VP', 'mp41', 'mp42', 'mp4v', 'mp71', 'MSNV',
])
const MP4_LEADING_BOXES = new Set(['free', 'skip', 'wide', 'uuid'])

function looksLikeMp4(buf: Buffer): boolean {
  const limit = Math.min(buf.length, MIME_SNIFF_MAX_BYTES)
  let boxOffset = 0
  while (boxOffset + 8 <= limit) {
    const size32 = buf.readUInt32BE(boxOffset)
    const type = buf.toString('ascii', boxOffset + 4, boxOffset + 8)
    let headerSize = 8
    let boxSize = size32
    if (size32 === 1) {
      if (boxOffset + 16 > limit) return false
      const largeSize = buf.readBigUInt64BE(boxOffset + 8)
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false
      boxSize = Number(largeSize)
      headerSize = 16
    } else if (size32 === 0) {
      return false
    }
    if (boxSize < headerSize || boxOffset + boxSize > limit) return false
    if (type === 'ftyp') {
      if (boxSize < headerSize + 8 || (boxSize - headerSize) % 4 !== 0) return false
      if (MP4_BRANDS.has(buf.toString('ascii', boxOffset + headerSize, boxOffset + headerSize + 4))) return true
      for (let brandOffset = boxOffset + headerSize + 8; brandOffset + 4 <= boxOffset + boxSize; brandOffset += 4) {
        if (MP4_BRANDS.has(buf.toString('ascii', brandOffset, brandOffset + 4))) return true
      }
      return false
    }
    if (!MP4_LEADING_BOXES.has(type)) return false
    boxOffset += boxSize
  }
  return false
}

function looksLikeText(buf: Buffer): boolean {
  // Fast heuristic: no NUL byte in the first 4KB and >90% printable ASCII
  // or UTF-8 continuation bytes.
  const sample = buf.slice(0, 4096)
  let printable = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i]!
    if (c === 0) return false
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0x7e) || c >= 0x80) printable += 1
  }
  return sample.length === 0 || printable / sample.length > 0.9
}

function errorResponse(
  requestId: string,
  code: 'EACCES' | 'ENOENT' | 'EINVAL' | 'EIO',
  message: string,
): WorkspaceReadBinaryResponse {
  return {
    requestId,
    base64: '',
    mime: 'application/octet-stream',
    size: 0,
    error: { code, message },
  }
}
