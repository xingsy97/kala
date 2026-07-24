import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'

import ignore from 'ignore'

import type { FileListEntry } from '@agent-kernel/shared'

const FILE_LIST_SKIP_PATTERNS = [
  'node_modules/',
  '.git/',
  '.pnpm/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.turbo/',
  '.cache/',
  'coverage/',
  '.*',
]

export type DiscoverWorkspaceFilesInput = {
  roots: readonly string[]
  query: string
  limit: number
  walkCeiling: number
}

export type DiscoverWorkspaceFilesResult = {
  files: FileListEntry[]
  truncated: boolean
}

export async function discoverWorkspaceFiles(input: DiscoverWorkspaceFilesInput): Promise<DiscoverWorkspaceFilesResult> {
  const query = input.query.trim().toLowerCase()
  const matcher = ignore().add(FILE_LIST_SKIP_PATTERNS)
  const matches: FileListEntry[] = []
  let walked = 0
  let truncated = false

  for (const root of input.roots) {
    if (walked >= input.walkCeiling || matches.length >= input.limit) {
      truncated = true
      break
    }
    await walkWorkspaceRoot(root, async (absPath, isDirectory) => {
      const rel = toPosixRelative(root, absPath)
      if (!rel) return 'continue'
      if (matcher.ignores(isDirectory ? `${rel}/` : rel)) return 'skip'
      walked += 1
      if (walked > input.walkCeiling) {
        truncated = true
        return 'stop'
      }
      if (isDirectory) return 'continue'
      if (basename(absPath).startsWith('.')) return 'skip'
      if (query.length > 0 && !rel.toLowerCase().includes(query)) return 'skip'
      const info = await stat(absPath).catch(() => undefined)
      if (matches.length >= input.limit) {
        truncated = true
        return 'stop'
      }
      matches.push({ path: rel, size: info?.size ?? 0 })
      return 'continue'
    })
  }

  matches.sort((a, b) => a.path.localeCompare(b.path))
  return { files: matches, truncated }
}

function toPosixRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}

async function walkWorkspaceRoot(
  root: string,
  visit: (absPath: string, isDirectory: boolean) => Promise<'continue' | 'skip' | 'stop'> | 'continue' | 'skip' | 'stop',
): Promise<void> {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const dirsToVisit: string[] = []
    for (const entry of entries) {
      const absPath = join(dir, entry.name)
      const isDirectory = entry.isDirectory()
      const action = await visit(absPath, isDirectory)
      if (action === 'stop') return
      if (isDirectory && action === 'continue') dirsToVisit.push(absPath)
    }
    for (let i = dirsToVisit.length - 1; i >= 0; i--) {
      stack.push(dirsToVisit[i]!)
    }
  }
}
