import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { optionalPositiveInt, requireString } from './schema.js'
import { readOneFile } from './read-file.js'

const MAX_FILES = 20
const DEFAULT_MAX_BYTES = 200_000
const HARD_MAX_BYTES = 1_000_000

type ReadFileEntry = { path: string; offset?: number; limit?: number }

export const readFilesTool: Tool = {
  name: 'read_files',
  async run(input, ctx) {
    const files = parseFiles(input)
    const requestedMax = optionalPositiveInt(input, 'max_bytes', 1) ?? DEFAULT_MAX_BYTES
    const maxBytes = Math.min(requestedMax, HARD_MAX_BYTES)
    const chunks: string[] = []
    let totalBytes = 0
    const marker = `... read_files output truncated at ${maxBytes} bytes ...`
    for (const file of files) {
      const content = await readOneFile(file, ctx)
      const chunk = `===== ${file.path} =====\n${content}`
      const separator = chunks.length > 0 ? '\n\n' : ''
      const chunkBytes = Buffer.byteLength(separator + chunk, 'utf8')
      if (totalBytes + chunkBytes <= maxBytes) {
        chunks.push(chunk)
        totalBytes += chunkBytes
        continue
      }
      const separatorBytes = Buffer.byteLength('\n\n', 'utf8')
      const markerBytes = Buffer.byteLength(marker, 'utf8')
      const remaining = Math.max(0, maxBytes - totalBytes - markerBytes - separatorBytes * 2)
      if (remaining > 0) chunks.push(truncateUtf8(chunk, remaining))
      chunks.push(marker)
      break
    }
    return chunks.join('\n\n')
  },
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  // UTF-8 continuation bytes cannot begin a decoded suffix. Back up to the
  // start of the final code point so truncation never emits U+FFFD.
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function parseFiles(input: Record<string, unknown>): ReadFileEntry[] {
  const raw = input['files']
  if (!Array.isArray(raw)) throw new ToolError('EINVAL', 'missing or non-array field "files"')
  if (raw.length === 0) throw new ToolError('EINVAL', 'files must not be empty')
  if (raw.length > MAX_FILES) throw new ToolError('E2BIG', `read_files supports at most ${MAX_FILES} files`)
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolError('EINVAL', `files[${index}] must be an object`)
    const record = item as Record<string, unknown>
    const path = requireString(record, 'path')
    const offset = optionalPositiveInt(record, 'offset', 0)
    const limit = optionalPositiveInt(record, 'limit', 1)
    return { path, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) }
  })
}
