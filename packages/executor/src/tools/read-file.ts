import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { optionalPositiveInt, requireString } from './schema.js'

const DEFAULT_LIMIT = 2000
const MAX_BYTES = 5 * 1024 * 1024

export const readFileTool: Tool = {
  name: 'read_file',
  async run(input, ctx) {
    const path = requireString(input, 'path')
    const offset = input['offset'] === undefined ? 0 : optionalPositiveInt(input, 'offset', 0)!
    const limit = optionalPositiveInt(input, 'limit', 1) ?? DEFAULT_LIMIT
    return readOneFile({ path, offset, limit }, ctx)
  },
}

export async function readOneFile(
  input: { path: string; offset?: number; limit?: number },
  ctx: Parameters<Tool['run']>[1],
): Promise<string> {
  const offset = input.offset ?? 0
  const limit = input.limit ?? DEFAULT_LIMIT
  let resolved: string
  try {
    resolved = await ctx.sandbox.resolve(input.path, { cwd: ctx.cwd })
  } catch (err) {
    if (err instanceof SandboxError) throw new ToolError(err.code, err.message)
    throw err
  }

  let s
  try {
    s = await stat(resolved)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EIO'
    if (code === 'ENOENT') throw new ToolError('ENOENT', `no such file: ${input.path}`)
    if (code === 'EACCES') throw new ToolError('EACCES', `permission denied: ${input.path}`)
    throw new ToolError(code, `stat failed: ${(err as Error).message}`)
  }
  if (s.isDirectory()) throw new ToolError('EISDIR', `path is a directory (use list_directory): ${input.path}`)
  if (s.size > MAX_BYTES) throw new ToolError('E2BIG', `file exceeds size limit (${s.size} bytes); use offset/limit or run_shell+head`)

  const bytes = await readFile(resolved)
  if (looksBinary(bytes)) throw new ToolError('EBINARY', `binary file cannot be rendered as text: ${input.path}; use image/file preview or download`)
  const content = formatNumberedLines(bytes.toString('utf8'), offset, limit)
  return `${content}\n\n--- file metadata ---\nrevision: sha256:${createHash('sha256').update(bytes).digest('hex')}\nsize: ${bytes.length}`
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192))
  if (sample.includes(0)) return true
  if (sample.length === 0) return false
  let control = 0
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) control += 1
  return control / sample.length > 0.1
}

export function formatNumberedLines(raw: string, offset: number, limit: number): string {
  const lines = raw.split('\n')
  const slice = lines.slice(offset, offset + limit)
  const width = String(offset + slice.length).length
  return slice.map((line, i) => `${String(offset + i + 1).padStart(width, ' ')}\t${line}`).join('\n')
}
