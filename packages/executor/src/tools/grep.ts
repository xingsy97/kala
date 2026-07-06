import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import picomatch from 'picomatch'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { optionalBoolean, optionalString, requireString } from './schema.js'

const MAX_LINES = 1000
const MAX_FILES = 10_000

type OutputMode = 'files_with_matches' | 'count' | 'content'

function parseMode(input: Record<string, unknown>): OutputMode {
  const raw = optionalString(input, 'output_mode')
  if (raw === undefined) return 'files_with_matches'
  if (raw === 'files_with_matches' || raw === 'count' || raw === 'content')
    return raw
  throw new ToolError('EINVAL', `invalid output_mode: ${raw}`)
}

async function collectFiles(
  root: string,
  filter: ((rel: string) => boolean) | null,
): Promise<string[]> {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        const rel = relative(root, full)
        if (!filter || filter(rel)) out.push(full)
        if (out.length > MAX_FILES) return out
      }
    }
  }
  return out
}

export const grepTool: Tool = {
  name: 'grep',
  async run(input, ctx) {
    const pattern = requireString(input, 'pattern')
    const pathInput = optionalString(input, 'path')
    const globPattern = optionalString(input, 'glob')
    const caseInsensitive = optionalBoolean(input, 'case_insensitive') ?? false
    const mode = parseMode(input)

    let regex: RegExp
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'i' : '')
    } catch (err) {
      throw new ToolError(
        'EINVAL',
        `invalid regex: ${pattern} (${(err as Error).message})`,
      )
    }

    const rootInput = pathInput ?? ctx.cwd ?? ctx.sandbox.roots[0]!
    let resolvedRoot: string
    try {
      resolvedRoot = await ctx.sandbox.resolve(rootInput, { cwd: ctx.cwd })
    } catch (err) {
      if (err instanceof SandboxError) throw new ToolError(err.code, err.message)
      throw err
    }

    let s
    try {
      s = await stat(resolvedRoot)
    } catch {
      throw new ToolError('ENOENT', `path not found: ${rootInput}`)
    }

    const globFilter = globPattern
      ? picomatch(globPattern, { dot: true })
      : null

    const files: string[] = s.isFile()
      ? [resolvedRoot]
      : await collectFiles(resolvedRoot, globFilter)

    const results: string[] = []
    let totalLines = 0
    let truncated = false

    for (const file of files) {
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      let fileCount = 0
      const contentHits: Array<{ line: number; text: string }> = []
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          fileCount++
          if (mode === 'content') contentHits.push({ line: i + 1, text: lines[i]! })
        }
      }
      if (fileCount === 0) continue
      if (mode === 'files_with_matches') {
        results.push(file)
        totalLines++
      } else if (mode === 'count') {
        results.push(`${file}:${fileCount}`)
        totalLines++
      } else {
        for (const hit of contentHits) {
          if (totalLines >= MAX_LINES) {
            truncated = true
            break
          }
          results.push(`${file}:${hit.line}:${hit.text}`)
          totalLines++
        }
      }
      if (totalLines >= MAX_LINES) {
        truncated = true
        break
      }
    }

    if (truncated) {
      results.push(
        `... and more matches (refine pattern or use output_mode=count)`,
      )
    }
    return results.join('\n')
  },
}
