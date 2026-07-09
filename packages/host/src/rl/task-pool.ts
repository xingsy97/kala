import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

import { AgentRlTaskPoolSchema, AgentRlTaskSchema, type AgentRlTask } from '@agent-kernel/shared/enhancement'

export type TaskPoolValidation = {
  schemaVersion: 'agent.rl.task_pool_validation.v1'
  taskFile: string
  taskCount: number
  trainingAllowedCount: number
  blockedCount: number
  warnings: readonly string[]
  tasks: readonly AgentRlTask[]
}

export async function loadTaskPoolFile(path: string, options: { trainingMode?: boolean; workspaceRoot?: string } = {}): Promise<TaskPoolValidation> {
  const text = await readFile(path, 'utf8')
  const trimmed = text.trim()
  const tasks = trimmed.startsWith('{')
    ? parseJsonObjectPool(trimmed, path)
    : parseJsonLinesPool(text, path)
  return validateTaskPool(path, tasks, options)
}

export function validateTaskPool(path: string, rawTasks: readonly unknown[], options: { trainingMode?: boolean; workspaceRoot?: string } = {}): TaskPoolValidation {
  const tasks: AgentRlTask[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const [index, raw] of rawTasks.entries()) {
    const parsed = AgentRlTaskSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`invalid task at index ${index}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    }
    const task = parsed.data
    if (seen.has(task.taskId)) throw new Error(`duplicate taskId: ${task.taskId}`)
    seen.add(task.taskId)
    validateTaskSemantics(task, options)
    if (task.governance.redactionStatus === 'blocked') warnings.push(`${task.taskId}: redaction blocked`)
    if (!task.governance.trainingAllowed) warnings.push(`${task.taskId}: training not allowed`)
    tasks.push(task)
  }
  if (options.trainingMode) {
    const blocked = tasks.filter((task) => !task.governance.trainingAllowed || task.governance.redactionStatus === 'blocked')
    if (blocked.length > 0) throw new Error(`training mode rejects blocked tasks: ${blocked.map((task) => task.taskId).join(', ')}`)
  }
  return {
    schemaVersion: 'agent.rl.task_pool_validation.v1',
    taskFile: path,
    taskCount: tasks.length,
    trainingAllowedCount: tasks.filter((task) => task.governance.trainingAllowed).length,
    blockedCount: tasks.filter((task) => !task.governance.trainingAllowed || task.governance.redactionStatus === 'blocked').length,
    warnings,
    tasks,
  }
}

function parseJsonObjectPool(text: string, path: string): readonly unknown[] {
  const parsed = JSON.parse(text) as unknown
  const pool = AgentRlTaskPoolSchema.safeParse(parsed)
  if (pool.success) return pool.data.tasks
  const task = AgentRlTaskSchema.safeParse(parsed)
  if (task.success) return [task.data]
  throw new Error(`task file must contain AgentRlTaskV1, AgentRlTaskPoolV1, or JSONL tasks: ${path}`)
}

function parseJsonLinesPool(text: string, path: string): readonly unknown[] {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) throw new Error(`task file is empty: ${path}`)
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`invalid JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

function validateTaskSemantics(task: AgentRlTask, options: { workspaceRoot?: string }): void {
  if (task.verifier.kind === 'command' && (!task.verifier.command || task.verifier.command.length === 0)) {
    throw new Error(`${task.taskId}: command verifier requires verifier.command`)
  }
  if (task.workspace.kind === 'git' && !task.workspace.repoUrl) {
    throw new Error(`${task.taskId}: git workspace requires repoUrl`)
  }
  if (task.workspace.kind === 'archive' && !task.workspace.archiveRef) {
    throw new Error(`${task.taskId}: archive workspace requires archiveRef`)
  }
  if (task.workspace.workdir) assertInsideRoot(task.workspace.workdir, options.workspaceRoot, `${task.taskId}: workspace.workdir`)
  if (task.workspace.archiveRef) assertInsideRoot(task.workspace.archiveRef, options.workspaceRoot, `${task.taskId}: workspace.archiveRef`)
}

function assertInsideRoot(path: string, root: string | undefined, label: string): void {
  if (!root) return
  if (isAbsolute(path)) {
    const resolvedRoot = resolve(root)
    const resolvedPath = resolve(path)
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) throw new Error(`${label} escapes workspace root`)
    return
  }
  const normalized = normalize(path)
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) throw new Error(`${label} escapes workspace root`)
}
