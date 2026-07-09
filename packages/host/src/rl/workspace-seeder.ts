import { mkdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AgentRlTask } from '@agent-kernel/shared/enhancement'

export async function seedWorkspace(workdir: string, task: AgentRlTask): Promise<void> {
  await mkdir(workdir, { recursive: true })
  const ws = task.workspace
  if (ws.kind === 'empty-tempdir') return
  if (ws.kind === 'archive') {
    const ref = ws.archiveRef
    if (!ref) throw new Error(`archive workspace requires archiveRef (task ${task.taskId})`)
    const archivePath = resolveArchivePath(ref)
    const st = await stat(archivePath).catch(() => null)
    if (!st || !st.isFile()) throw new Error(`archive not found: ${archivePath} (task ${task.taskId})`)
    await runOrThrow(['tar', '-xzf', archivePath, '-C', workdir])
    return
  }
  if (ws.kind === 'git') {
    const { seedGitWorkspace } = await import('./workspace-git.js')
    await seedGitWorkspace(workdir, task)
    return
  }
}

function resolveArchivePath(ref: string): string {
  if (ref.startsWith('file://')) return fileURLToPath(ref)
  if (ref.startsWith('/')) return ref
  throw new Error(`archiveRef must be a file:// URL or absolute path, got: ${ref}`)
}

function runOrThrow(cmd: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const [head, ...rest] = cmd
    if (!head) return reject(new Error('empty command'))
    const proc = spawn(head, rest, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd.join(' ')} exited ${code}: ${stderr.slice(0, 400)}`))
    })
  })
}
