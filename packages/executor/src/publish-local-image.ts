import { lstat, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import type { Sandbox } from './sandbox.js'
import { isPathInsideRoot } from './sandbox.js'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'])

export type PublishLocalImageRequest = { requestId: string; path: string; cwd?: string }
export type PublishLocalImageResponse = { requestId: string; path: string; base64?: string; mediaType?: string; size?: number; error?: string }

export async function publishLocalImage(input: PublishLocalImageRequest, sandbox: Sandbox): Promise<PublishLocalImageResponse> {
  const fail = (error: string): PublishLocalImageResponse => ({ requestId: input.requestId, path: input.path, error })
  try {
    const candidate = isAbsolute(input.path) ? resolve(input.path) : await sandbox.resolve(input.path, input.cwd ? { cwd: input.cwd } : undefined)
    let canonical: string
    try { canonical = await sandbox.resolve(candidate) }
    catch {
      canonical = await realpath(candidate)
      const tempRoot = await realpath(tmpdir())
      if (!isPathInsideRoot(canonical, tempRoot)) return fail('image is outside the workspace and system temporary directory')
    }
    const info = await lstat(candidate)
    if (info.isSymbolicLink()) return fail('symbolic links cannot be published')
    if (!info.isFile()) return fail('image is not a regular file')
    if (info.size < 1 || info.size > MAX_IMAGE_BYTES) return fail(`image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`)
    if (typeof process.getuid === 'function' && isPathInsideRoot(canonical, await realpath(tmpdir())) && info.uid !== process.getuid()) return fail('temporary image is not owned by the Executor user')
    const data = await readFile(canonical)
    const mediaType = sniffImageMime(data)
    if (!mediaType || !IMAGE_MIMES.has(mediaType)) return fail('file is not a supported PNG, JPEG, WebP, GIF, or SVG image')
    return { requestId: input.requestId, path: input.path, base64: data.toString('base64'), mediaType, size: data.length }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

function sniffImageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  const head = data.subarray(0, 6).toString('ascii')
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (/^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(data.subarray(0, 64 * 1024).toString('utf8'))) return 'image/svg+xml'
  return undefined
}
