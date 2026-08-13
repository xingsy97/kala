import type { Tool } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import { grepTool } from './grep.js'
import { optionalPositiveInt, optionalString, requireString } from './schema.js'

const MAX_SEARCHES = 20
const DEFAULT_MAX_BYTES = 200_000
const HARD_MAX_BYTES = 1_000_000
const MODES = new Set(['content', 'files_with_matches', 'count'])

type Search = Record<string, unknown> & { pattern: string }

export const multiGrepTool: Tool = {
  name: 'multi_grep',
  async run(input, ctx) {
    const searches = parseSearches(input)
    const requestedMax = optionalPositiveInt(input, 'max_bytes', 1) ?? DEFAULT_MAX_BYTES
    const maxBytes = Math.min(requestedMax, HARD_MAX_BYTES)
    const chunks: string[] = []
    let bytes = 0
    for (let index = 0; index < searches.length; index += 1) {
      throwIfAborted(ctx)
      const search = searches[index]!
      const header = `===== search[${index}] =====`
      const result = await grepTool.run(search, ctx)
      const chunk = `${header}\n${result}`
      const separator = chunks.length ? '\n\n' : ''
      const nextBytes = Buffer.byteLength(separator + chunk, 'utf8')
      if (bytes + nextBytes <= maxBytes) {
        chunks.push(chunk)
        bytes += nextBytes
        continue
      }
      const remainingCount = searches.length - index
      const marker = `... multi_grep output truncated at ${maxBytes} bytes; ${remainingCount} searches not fully returned ...`
      const reserved = Buffer.byteLength(`${separator}\n\n${marker}`, 'utf8')
      const available = Math.max(0, maxBytes - bytes - reserved)
      if (available > 0) chunks.push(truncateUtf8(chunk, available))
      chunks.push(marker)
      break
    }
    return fitUtf8(chunks.join('\n\n'), maxBytes)
  },
}

function parseSearches(input: Record<string, unknown>): Search[] {
  const raw = input['searches']
  if (!Array.isArray(raw)) throw new ToolError('EINVAL', 'missing or non-array field "searches"')
  if (raw.length === 0) throw new ToolError('EINVAL', 'searches must not be empty')
  if (raw.length > MAX_SEARCHES) throw new ToolError('E2BIG', `multi_grep supports at most ${MAX_SEARCHES} searches`)
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolError('EINVAL', `searches[${index}] must be an object`)
    const record = item as Record<string, unknown>
    const pattern = requireString(record, 'pattern')
    try { new RegExp(pattern, record['case_insensitive'] === true ? 'i' : '') } catch { throw new ToolError('EINVAL', `invalid regex in searches[${index}]`) }
    const mode = optionalString(record, 'output_mode')
    if (mode !== undefined && !MODES.has(mode)) throw new ToolError('EINVAL', `invalid output_mode in searches[${index}]: ${mode}`)
    if (record['case_insensitive'] !== undefined && typeof record['case_insensitive'] !== 'boolean') throw new ToolError('EINVAL', `searches[${index}].case_insensitive must be boolean`)
    return { ...record, pattern }
  })
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function fitUtf8(value: string, maxBytes: number): string {
  return Buffer.byteLength(value, 'utf8') <= maxBytes ? value : truncateUtf8(value, maxBytes)
}
