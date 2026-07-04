import { readFile, stat } from 'node:fs/promises'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { optionalPositiveInt, requireString } from './schema.js'

const DEFAULT_LIMIT = 2000
const MAX_BYTES = 5 * 1024 * 1024

export const readTool: Tool = {
  name: 'read',
  async run(input, ctx) {
    const path = requireString(input, 'path')
    const offset = input['offset'] === undefined
      ? 0
      : optionalPositiveInt(input, 'offset', 0)!
    const limit = optionalPositiveInt(input, 'limit', 1) ?? DEFAULT_LIMIT

    let resolved: string
    try {
      resolved = await ctx.sandbox.resolve(path)
    } catch (err) {
      if (err instanceof SandboxError) throw new ToolError(err.code, err.message)
      throw err
    }

    let s
    try {
      s = await stat(resolved)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'EIO'
      if (code === 'ENOENT') {
        throw new ToolError('ENOENT', `no such file: ${path}`)
      }
      if (code === 'EACCES') {
        throw new ToolError('EACCES', `permission denied: ${path}`)
      }
      throw new ToolError(code, `stat failed: ${(err as Error).message}`)
    }
    if (s.isDirectory()) {
      throw new ToolError('EISDIR', `path is a directory (use ls): ${path}`)
    }
    if (s.size > MAX_BYTES) {
      throw new ToolError(
        'E2BIG',
        `file exceeds size limit (${s.size} bytes); use offset/limit or bash+head`,
      )
    }

    const raw = await readFile(resolved, 'utf8')
    const lines = raw.split('\n')
    const slice = lines.slice(offset, offset + limit)
    const width = String(offset + slice.length).length
    return slice
      .map((line, i) => `${String(offset + i + 1).padStart(width, ' ')}\t${line}`)
      .join('\n')
  },
}
