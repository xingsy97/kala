import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import type { AgentRlTask } from '@agent-kernel/shared/enhancement'

export type GitCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type GitRunner = (args: readonly string[], opts: { cwd?: string; stdin?: string }) => Promise<GitCommandResult>

export class WorkspaceSeedError extends Error {
  public override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'WorkspaceSeedError'
    this.cause = cause
  }
}

type GitWorkspace = {
  kind: 'git'
  repoUrl?: string
  baseCommit?: string
  testPatch?: string
}

const defaultRunner: GitRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args as string[], {
      cwd: opts.cwd,
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c) => { stdout += String(c) })
    child.stderr?.on('data', (c) => { stderr += String(c) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }))
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin)
    }
  })

export type SeedGitWorkspaceOptions = {
  runner?: GitRunner
  cloneDepth?: number
  deepFallbackDepth?: number
}

export async function seedGitWorkspace(
  workspace: string,
  task: AgentRlTask,
  options: SeedGitWorkspaceOptions = {},
): Promise<{ headSha: string; applied: boolean }> {
  if (task.workspace.kind !== 'git') {
    throw new WorkspaceSeedError(`seedGitWorkspace called with kind=${task.workspace.kind}`)
  }
  const ws = task.workspace as GitWorkspace
  if (!ws.repoUrl) throw new WorkspaceSeedError(`git workspace requires repoUrl (task ${task.taskId})`)
  if (!ws.baseCommit) throw new WorkspaceSeedError(`git workspace requires baseCommit (task ${task.taskId})`)

  const testPatch = readTestPatch(task, ws)
  const runner = options.runner ?? defaultRunner
  const depth = options.cloneDepth ?? 200
  const deepDepth = options.deepFallbackDepth ?? 1000

  await mkdir(workspace, { recursive: true })

  const clone = await runner(['clone', `--depth=${depth}`, ws.repoUrl, workspace], {})
  if (clone.exitCode !== 0) {
    throw new WorkspaceSeedError(
      `git clone failed for task ${task.taskId}: exit=${clone.exitCode} stderr=${clone.stderr.slice(0, 400)}`,
    )
  }

  let checkout = await runner(['checkout', ws.baseCommit], { cwd: workspace })
  if (checkout.exitCode !== 0) {
    const fetch = await runner(['fetch', '--depth', String(deepDepth), 'origin', ws.baseCommit], { cwd: workspace })
    if (fetch.exitCode !== 0) {
      throw new WorkspaceSeedError(
        `git fetch deep failed for task ${task.taskId}: exit=${fetch.exitCode} stderr=${fetch.stderr.slice(0, 400)}`,
      )
    }
    checkout = await runner(['checkout', ws.baseCommit], { cwd: workspace })
    if (checkout.exitCode !== 0) {
      throw new WorkspaceSeedError(
        `git checkout ${ws.baseCommit} failed for task ${task.taskId}: exit=${checkout.exitCode} stderr=${checkout.stderr.slice(0, 400)}`,
      )
    }
  }

  const headSha = (await runner(['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim()

  let applied = false
  if (testPatch !== null) {
    const patchPath = join(workspace, '.agent-kernel-test.patch')
    await writeFile(patchPath, testPatch, 'utf8')
    const apply = await runner(['apply', '--index', patchPath], { cwd: workspace })
    if (apply.exitCode !== 0) {
      throw new WorkspaceSeedError(
        `git apply testPatch failed for task ${task.taskId}: exit=${apply.exitCode} stderr=${apply.stderr.slice(0, 400)}\n--- patch head ---\n${testPatch.slice(0, 400)}`,
      )
    }
    const commitEnv = ['-c', 'user.email=agent-kernel@local', '-c', 'user.name=agent-kernel']
    const commit = await runner([...commitEnv, 'commit', '--no-verify', '--allow-empty', '-m', 'agent-kernel: apply testPatch'], { cwd: workspace })
    if (commit.exitCode !== 0) {
      throw new WorkspaceSeedError(
        `git commit testPatch failed for task ${task.taskId}: exit=${commit.exitCode} stderr=${commit.stderr.slice(0, 400)}`,
      )
    }
    await unlink(patchPath).catch(() => undefined)
    applied = true
  }

  const finalHead = testPatch !== null
    ? (await runner(['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim()
    : headSha
  return { headSha: finalHead, applied }
}

function readTestPatch(task: AgentRlTask, ws: GitWorkspace): string | null {
  if (typeof ws.testPatch === 'string' && ws.testPatch.length > 0) return ws.testPatch
  const meta = task.metadata as Record<string, unknown> | undefined
  const patch = meta?.testPatch
  if (typeof patch === 'string' && patch.length > 0) return patch
  return null
}
