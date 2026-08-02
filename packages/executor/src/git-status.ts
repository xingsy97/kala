import { workspaceExec } from './workspace-exec.js'
import type { Sandbox } from './sandbox.js'

export type GitWorkspaceStatus = {
  kind: 'repository' | 'not_repository' | 'git_unavailable'
  branch?: string
  detached?: boolean
  staged?: number
  unstaged?: number
  untracked?: number
  conflicted?: number
  submodules?: number
  error?: string
}

export async function inspectGitWorkspace(input: { workspaceId: string; cwd: string }, sandbox: Sandbox): Promise<GitWorkspaceStatus> {
  const result = await workspaceExec({
    requestId: `git-status-${Date.now()}`,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    argv: ['git', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
    timeoutMs: 10_000,
    maxOutputBytes: 512_000,
  }, sandbox)
  if (result.error) {
    if (result.error.code === 'ENOENT' || /not found/iu.test(result.error.message)) return { kind: 'git_unavailable', error: result.error.message }
    return { kind: 'not_repository', error: result.error.message }
  }
  if (result.exitCode !== 0) {
    const text = `${result.stderr ?? ''} ${result.stdout ?? ''}`.trim()
    if (/not a git repository/iu.test(text)) return { kind: 'not_repository' }
    return { kind: 'repository', error: text || `git exited ${result.exitCode}` }
  }
  return parseGitPorcelainV2(result.stdout ?? '')
}

export function parseGitPorcelainV2(output: string): GitWorkspaceStatus {
  let branch: string | undefined, detached = false, staged = 0, unstaged = 0, untracked = 0, conflicted = 0, submodules = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) { const value = line.slice(14).trim(); detached = value === '(detached)'; if (!detached) branch = value }
    else if (line.startsWith('? ')) untracked += 1
    else if (line.startsWith('u ')) conflicted += 1
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' '), xy = parts[1] ?? '..', sub = parts[2] ?? 'N...'
      if (xy[0] !== '.') staged += 1
      if (xy[1] !== '.') unstaged += 1
      if (sub !== 'N...') submodules += 1
    }
  }
  return { kind: 'repository', ...(branch ? { branch } : {}), detached, staged, unstaged, untracked, conflicted, submodules }
}
