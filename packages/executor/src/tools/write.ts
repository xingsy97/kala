import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { throwIfAborted, ToolError } from './registry.js'
import { requireString } from './schema.js'

const MAX_BYTES = 5 * 1024 * 1024

export const writeTool: Tool = {
  name: 'write',
  async run(input, ctx) {
    const path = requireString(input, 'path')
    const content = requireString(input, 'content')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_BYTES) {
      throw new ToolError('E2BIG', `content exceeds size limit (${bytes} bytes)`)
    }

    // Fail fast if the caller already lost interest. Cheap check, big payoff:
    // no directory creation, no file write, no half-applied state.
    throwIfAborted(ctx)

    let resolved: string
    try {
      resolved = await ctx.sandbox.resolve(path)
    } catch (err) {
      if (err instanceof SandboxError) throw new ToolError(err.code, err.message)
      throw err
    }

    let existed = true
    try {
      const s = await stat(resolved)
      if (s.isDirectory()) {
        throw new ToolError('EISDIR', `path is a directory: ${path}`)
      }
    } catch (err) {
      if (err instanceof ToolError) throw err
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') existed = false
      else if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new ToolError('EACCES', `permission denied: ${path}`)
      } else throw err
    }

    // Final guard immediately before mutation. Everything above is read-only.
    throwIfAborted(ctx)

    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, content, 'utf8')

    return existed
      ? `Wrote ${bytes} bytes to ${resolved}`
      : `Created ${resolved} with ${bytes} bytes`
  },
}
