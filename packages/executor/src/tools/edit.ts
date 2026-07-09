import { readFile, stat, writeFile } from 'node:fs/promises'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { throwIfAborted, ToolError } from './registry.js'
import { optionalBoolean, requireString } from './schema.js'

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = 0
  while (true) {
    const next = haystack.indexOf(needle, idx)
    if (next === -1) return count
    count++
    idx = next + needle.length
  }
}

export const editTool: Tool = {
  name: 'edit',
  async run(input, ctx) {
    const path = requireString(input, 'path')
    const oldString = requireString(input, 'old_string')
    const newString = requireString(input, 'new_string')
    const replaceAll = optionalBoolean(input, 'replace_all') ?? false

    if (oldString.length === 0) {
      throw new ToolError('EINVAL', 'old_string must be non-empty')
    }
    if (oldString === newString) {
      throw new ToolError('EINVAL', 'old_string equals new_string; nothing to do')
    }

    throwIfAborted(ctx)

    let resolved: string
    try {
      resolved = await ctx.sandbox.resolve(path)
    } catch (err) {
      if (err instanceof SandboxError) throw new ToolError(err.code, err.message)
      throw err
    }

    try {
      const s = await stat(resolved)
      if (s.isDirectory()) {
        throw new ToolError('EISDIR', `path is a directory: ${path}`)
      }
    } catch (err) {
      if (err instanceof ToolError) throw err
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ToolError(
          'ENOENT',
          `file does not exist (use write to create): ${path}`,
        )
      }
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new ToolError('EACCES', `permission denied: ${path}`)
      }
      throw err
    }

    const original = await readFile(resolved, 'utf8')
    const occurrences = countOccurrences(original, oldString)
    if (occurrences === 0) {
      throw new ToolError('ENOTFOUND', `old_string not found in ${path}`)
    }
    if (!replaceAll && occurrences > 1) {
      throw new ToolError(
        'EAMBIG',
        `old_string matches ${occurrences} times; set replace_all=true or provide more context`,
      )
    }

    let replaced: string
    let n: number
    if (replaceAll) {
      replaced = original.split(oldString).join(newString)
      n = occurrences
    } else {
      const idx = original.indexOf(oldString)
      replaced = original.slice(0, idx) + newString + original.slice(idx + oldString.length)
      n = 1
    }
    // Final guard immediately before mutating the file. Everything above is
    // read-only, so cancellation here is safe and cheap.
    throwIfAborted(ctx)
    await writeFile(resolved, replaced, 'utf8')
    return `Replaced ${n} occurrence(s) in ${resolved}`
  },
}
