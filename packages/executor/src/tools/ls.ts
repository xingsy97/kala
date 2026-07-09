import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { optionalBoolean, requireString } from './schema.js'

export const lsTool: Tool = {
  name: 'ls',
  async run(input, ctx) {
    const path = requireString(input, 'path')
    const hidden = optionalBoolean(input, 'hidden') ?? false

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
      if (code === 'ENOENT') throw new ToolError('ENOENT', `no such path: ${path}`)
      if (code === 'EACCES') throw new ToolError('EACCES', `permission denied: ${path}`)
      throw new ToolError(code, `stat failed: ${(err as Error).message}`)
    }
    if (!s.isDirectory()) {
      throw new ToolError('ENOTDIR', `not a directory: ${path}`)
    }

    const entries = await readdir(resolved, { withFileTypes: true })
    const rows: string[] = []
    for (const e of entries) {
      if (!hidden && e.name.startsWith('.')) continue
      let isDir = e.isDirectory()
      if (e.isSymbolicLink()) {
        try {
          const target = await stat(join(resolved, e.name))
          isDir = target.isDirectory()
        } catch {
          isDir = false
        }
      }
      rows.push(isDir ? `${e.name}/` : e.name)
    }
    rows.sort((a, b) => a.localeCompare(b))
    return rows.join('\n')
  },
}
