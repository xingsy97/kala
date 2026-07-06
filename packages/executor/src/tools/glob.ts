import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import picomatch from 'picomatch'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { optionalString, requireString } from './schema.js'

const MAX_MATCHES = 1000
const MAX_WALK = 100_000

async function walk(root: string, onFile: (abs: string) => void): Promise<void> {
  const stack: string[] = [root]
  let seen = 0
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (++seen > MAX_WALK) return
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
      } else if (e.isFile()) {
        onFile(full)
      }
    }
  }
}

export const globTool: Tool = {
  name: 'glob',
  async run(input, ctx) {
    const pattern = requireString(input, 'pattern')
    const cwdInput = optionalString(input, 'cwd')
    const root = cwdInput ?? ctx.cwd ?? ctx.sandbox.roots[0]!

    let resolvedRoot: string
    try {
      resolvedRoot = await ctx.sandbox.resolve(root, { cwd: ctx.cwd })
    } catch (err) {
      if (err instanceof SandboxError) throw new ToolError(err.code, err.message)
      throw err
    }

    let matcher: (p: string) => boolean
    try {
      matcher = picomatch(pattern, { dot: true })
    } catch (err) {
      throw new ToolError(
        'EINVAL',
        `invalid glob pattern: ${pattern} (${(err as Error).message})`,
      )
    }

    const matches: Array<{ path: string; mtimeMs: number }> = []
    await walk(resolvedRoot, (abs) => {
      const rel = relative(resolvedRoot, abs)
      if (matcher(rel)) matches.push({ path: abs, mtimeMs: 0 })
    })

    await Promise.all(
      matches.map(async (m) => {
        try {
          const s = await stat(m.path)
          m.mtimeMs = s.mtimeMs
        } catch {
          m.mtimeMs = 0
        }
      }),
    )
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const capped = matches.slice(0, MAX_MATCHES)
    const lines = capped.map((m) => m.path)
    if (matches.length > MAX_MATCHES) {
      lines.push(`... and ${matches.length - MAX_MATCHES} more (refine pattern)`)
    }
    return lines.join('\n')
  },
}
