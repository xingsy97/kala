import { ResolvedTaskSchema, assertTaskPublicationAllowed, canonicalJson, sha256Hex, type EvaluatedSlice, type ResolvedTask } from '@agent-kernel/eval-protocol'

export interface TaskCatalog {
  taskIdsForSlice(slice: EvaluatedSlice): Promise<readonly string[]>
  task(taskId: string): Promise<ResolvedTask>
  list(): Promise<readonly ResolvedTask[]>
}

export class RegisteredTaskCatalog implements TaskCatalog {
  private readonly slices = new Map<string, readonly string[]>()
  private readonly tasks = new Map<string, ResolvedTask>()

  register(sliceManifestHash: string, tasks: readonly (ResolvedTask | string)[]): void {
    if (tasks.length === 0) throw new Error('a registered evaluated slice must contain at least one task')
    const taskIds = tasks.map((task) => typeof task === 'string' ? task : assertTaskPublicationAllowed(task).taskId)
    if (new Set(taskIds).size !== taskIds.length) throw new Error('evaluated slice task IDs must be unique')
    this.slices.set(sliceManifestHash, taskIds)
    for (const task of tasks) if (typeof task !== 'string') this.tasks.set(task.taskId, assertTaskPublicationAllowed(task))
  }

  async taskIdsForSlice(slice: EvaluatedSlice): Promise<readonly string[]> {
    const taskIds = this.slices.get(slice.sliceManifestHash)
    if (!taskIds) throw new Error('evaluated slice is not registered: ' + slice.sliceManifestHash)
    if (taskIds.length !== slice.selectedItems) {
      throw new Error('registered task count does not match immutable evaluated slice')
    }
    if (await sha256Hex(canonicalJson(taskIds)) !== slice.selectionSpec.taskIdsHash) {
      throw new Error('registered task IDs do not match immutable evaluated slice manifest')
    }
    return taskIds
  }

  async task(taskId: string): Promise<ResolvedTask> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('task is not registered: ' + taskId)
    return task
  }

  async list(): Promise<readonly ResolvedTask[]> {
    return [...this.tasks.values()]
  }

  registrations(): readonly { sliceManifestHash: string; taskIds: readonly string[]; taskIdsHash: string; tasks: readonly ResolvedTask[] }[] {
    return [...this.slices.entries()].map(([sliceManifestHash, taskIds]) => ({
      sliceManifestHash, taskIds: [...taskIds], taskIdsHash: '', tasks: taskIds.map((taskId) => this.tasks.get(taskId)).filter((task): task is ResolvedTask => task !== undefined),
    }))
  }

  restore(registrations: readonly { sliceManifestHash: string; taskIds: readonly string[]; tasks: readonly ResolvedTask[] }[]): void {
    for (const registration of registrations) {
      const tasksById = new Map(registration.tasks.map((task) => [task.taskId, task]))
      this.register(registration.sliceManifestHash, registration.taskIds.map((taskId) => tasksById.get(taskId) ?? taskId))
    }
  }
}
