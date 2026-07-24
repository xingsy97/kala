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

  const readSize = Math.min(size, maxBytes)
  let buffer: Buffer
  try {
    // readFile always returns the full file; for over-cap files we read the
    // first `maxBytes` explicitly via file handle to avoid loading GB into
    // memory just to slice it.
    if (size > maxBytes) {
      const { open } = await import('node:fs/promises')
      const fh = await open(absolute, 'r')
      try {
        const buf = Buffer.alloc(readSize)
        await fh.read(buf, 0, readSize, 0)
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
  const truncated = size > maxBytes ? { maxBytes } : undefined
  return {
    requestId,
    base64: buffer.toString('base64'),
    mime,
    size,
    ...(truncated ? { truncated } : {}),
  }
}

function clampBytes(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested)) return DEFAULT_MAX_BYTES
  return Math.max(1, Math.min(HARD_MAX_BYTES, Math.floor(requested)))
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
