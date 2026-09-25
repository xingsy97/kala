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

import { readFile, stat } from 'node:fs/promises'

import type {
  WorkspaceReadBinaryRequest,
  WorkspaceReadBinaryResponse,
} from '@agent-kernel/shared/workspace-exec'

import type { Sandbox } from './sandbox.js'
import { SandboxError } from './sandbox.js'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const HARD_MAX_BYTES = 32 * 1024 * 1024

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
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return errorResponse(requestId, 'EINVAL', 'not a regular file')
    size = info.size
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return errorResponse(requestId, 'ENOENT', 'file does not exist')
    return errorResponse(requestId, 'EIO', err instanceof Error ? err.message : String(err))
  }

  if (offset > size) return errorResponse(requestId, 'EINVAL', 'offset is beyond end of file')
  const readSize = Math.min(size - offset, maxBytes)
  let buffer: Buffer
  try {
    // readFile always returns the full file; for ranged or over-cap reads we
    // read only the requested slice so large downloads can be assembled safely.
    if (offset > 0 || size > maxBytes) {
      const { open } = await import('node:fs/promises')
      const fh = await open(absolute, 'r')
      try {
        const buf = Buffer.alloc(readSize)
        await fh.read(buf, 0, readSize, offset)
        buffer = buf
      } finally {
        await fh.close()
      }
    } else {
      buffer = await readFile(absolute)
    }
  } catch (err) {
    return errorResponse(requestId, 'EIO', err instanceof Error ? err.message : String(err))
  }

  const mime = sniffMime(buffer, req.path)
  const truncated = offset + buffer.length < size ? { maxBytes } : undefined
  return {
    requestId,
    base64: buffer.toString('base64'),
    mime,
    size,
    offset,
    ...(truncated ? { truncated } : {}),
  }
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

// ISO-BMFF is also used by formats such as HEIF and QuickTime. Require an
// ftyp box at byte zero plus an MP4-specific major or compatible brand rather
// than trusting a .mp4 extension or classifying every ISO-BMFF file as video.
const MP4_BRANDS = new Set([
  'avc1', 'dash', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'isom', 'M4V ', 'M4VH', 'M4VP', 'mp41', 'mp42', 'mp4v', 'MSNV',
])

function looksLikeMp4(buf: Buffer): boolean {
  if (buf.length < 16 || buf.toString('ascii', 4, 8) !== 'ftyp') return false
  const boxSize = buf.readUInt32BE(0)
  if (boxSize < 16 || boxSize > buf.length || boxSize % 4 !== 0) return false
  if (MP4_BRANDS.has(buf.toString('ascii', 8, 12))) return true
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    if (MP4_BRANDS.has(buf.toString('ascii', offset, offset + 4))) return true
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
