import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  BenchmarkRunEventSchema,
  BenchmarkRunSpecSchema,
  type AgentBackendId,
  type BenchmarkRunEvent,
  type BenchmarkRunSpec,
  type BenchmarkRunState,
} from '@agent-kernel/shared'

import { getAgentBackend } from './agent-backend.js'
import { ingestSweBenchResults, runSweBenchAgentPatchRun, runSweBenchGrade } from '../swebench/swebench.js'

export type BenchmarkBackendRunStatus = {
  key: string
  backendId: AgentBackendId
  model: string
  state: 'queued' | 'running' | 'predictions_ready' | 'grading' | 'completed' | 'failed' | 'cancelled'
  runDir?: string
  predictionsPath?: string
  progressPath?: string
  summaryPath?: string
  total?: number
  completed?: number
  failed?: number
  timedOut?: number
  resolved?: number
  unresolved?: number
  gradingCommand?: readonly string[]
  error?: string
  startedAt?: string
  finishedAt?: string
}

export type BenchmarkRunStatus = {
  schemaVersion: 1
  runId: string
  state: BenchmarkRunState
  createdAt: string
  updatedAt: string
  lastSeq: number
  backends: BenchmarkBackendRunStatus[]
  error?: string
}

export type BenchmarkRunRecord = {
  spec: BenchmarkRunSpec
  status: BenchmarkRunStatus
}

export class BenchmarkRunService {
  private readonly active = new Map<string, AbortController>()
  private readonly writes = new Map<string, Promise<void>>()

  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
  }

  async create(input: unknown): Promise<BenchmarkRunRecord> {
    const spec = BenchmarkRunSpecSchema.parse(input)
    const directory = this.runDir(spec.runId)
    try {
      await readFile(join(directory, 'run.json'), 'utf8')
      throw new Error(`benchmark run already exists: ${spec.runId}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(directory, { recursive: true })
    const status: BenchmarkRunStatus = {
      schemaVersion: 1,
      runId: spec.runId,
      state: 'draft',
      createdAt: spec.createdAt,
      updatedAt: spec.createdAt,
      lastSeq: -1,
      backends: spec.backends.map((backend, index) => ({
        key: backendKey(backend.id, backend.model, backend.label, index),
        backendId: backend.id,
        model: backend.model,
        state: 'queued',
      })),
    }
    await atomicJson(join(directory, 'run.json'), spec)
    await atomicJson(join(directory, 'status.json'), status)
    await this.event(spec.runId, 'run.created', { benchmark: spec.benchmark })
    return await this.get(spec.runId)
  }

  async get(runId: string): Promise<BenchmarkRunRecord> {
    const directory = this.runDir(runId)
    const [spec, status] = await Promise.all([
      readFile(join(directory, 'run.json'), 'utf8').then((value) => BenchmarkRunSpecSchema.parse(JSON.parse(value))),
      readFile(join(directory, 'status.json'), 'utf8').then((value) => JSON.parse(value) as BenchmarkRunStatus),
    ])
    return { spec, status }
  }

  async list(): Promise<BenchmarkRunRecord[]> {
    let names: string[] = []
    try {
      names = await readdir(join(this.rootDir, 'benchmark-runs'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records = await Promise.all(names.map((name) => this.get(name).catch(() => undefined)))
    return records.filter((record): record is BenchmarkRunRecord => record !== undefined)
      .sort((a, b) => b.status.updatedAt.localeCompare(a.status.updatedAt))
  }

  async start(runId: string): Promise<BenchmarkRunRecord> {
    if (this.active.has(runId)) return await this.get(runId)
    const record = await this.get(runId)
    if (record.status.state === 'running') {
      await this.update(runId, (status) => ({ ...status, state: 'interrupted', error: 'Host restarted while run was active' }))
    }
    const controller = new AbortController()
    this.active.set(runId, controller)
    await this.update(runId, (status) => ({ ...status, state: 'running', error: undefined }))
    await this.event(runId, 'run.started')
    void this.execute(record.spec, controller.signal).finally(() => this.active.delete(runId))
    return await this.get(runId)
  }

  async run(runId: string): Promise<BenchmarkRunRecord> {
    await this.start(runId)
    while (this.active.has(runId)) await new Promise((resolve) => setTimeout(resolve, 50))
    return await this.get(runId)
  }

  async grade(runId: string, execute = true): Promise<BenchmarkRunRecord> {
    const record = await this.get(runId)
    if (record.spec.benchmark !== 'swebench') throw new Error(`grading not implemented for ${record.spec.benchmark}`)
    await this.update(runId, (status) => ({ ...status, state: 'grading' }))
    await this.event(runId, 'run.grading_started', { execute })
    for (const backend of record.status.backends) {
      if (!backend.predictionsPath || !backend.runDir) continue
      await this.backendUpdate(runId, backend.key, (current) => ({ ...current, state: 'grading' }))
      const resultsDir = join(backend.runDir, 'grade-results')
      await mkdir(resultsDir, { recursive: true })
      const existingOfficialReport = execute && (await readdir(resultsDir)).some((name) => name.endsWith('.json') && name !== 'results.json' && name !== 'instance_results.json')
      const grade = await runSweBenchGrade({
        datasetName: record.spec.dataset.source,
        predictionsPath: backend.predictionsPath,
        runId: `${record.spec.runId}-${backend.key}`,
        maxWorkers: record.spec.execution.maxWorkers,
        ...(record.spec.dataset.instanceIds ? { instanceIds: record.spec.dataset.instanceIds } : {}),
        cwd: resultsDir,
        execute: execute && !existingOfficialReport,
      })
      if (existingOfficialReport) Object.assign(grade, { exitCode: 0 })
      await this.backendUpdate(runId, backend.key, (current) => ({ ...current, gradingCommand: grade.command }))
      if (!execute) {
        await this.backendUpdate(runId, backend.key, (current) => ({ ...current, state: 'predictions_ready' }))
        continue
      }
      if (grade.exitCode !== 0) {
        await this.backendUpdate(runId, backend.key, (current) => ({ ...current, state: 'failed', error: `official grader exited ${grade.exitCode}` }))
        continue
      }
      const imported = await ingestSweBenchResults({ rootDir: dirname(backend.runDir), runId: basename(backend.runDir), resultsDir })
      const resolved = imported.trials.filter((trial) => trial.resolved).length
      await this.backendUpdate(runId, backend.key, (current) => ({ ...current, state: 'completed', resolved, unresolved: imported.trials.length - resolved, summaryPath: imported.summaryPath }))
      await this.event(runId, 'backend.graded', { resolved, total: imported.trials.length }, backend.backendId)
    }
    const after = await this.get(runId)
    const failed = after.status.backends.some((backend) => backend.state === 'failed')
    const pending = after.status.backends.some((backend) => backend.state === 'predictions_ready')
    await this.update(runId, (status) => ({ ...status, state: failed ? 'failed' : pending ? 'predictions_ready' : 'completed' }))
    await this.writeComparison(runId)
    await this.event(runId, failed ? 'run.failed' : pending ? 'run.grading_deferred' : 'run.completed')
    return await this.get(runId)
  }

  async cancel(runId: string): Promise<BenchmarkRunRecord> {
    this.active.get(runId)?.abort(new Error('benchmark run cancelled'))
    await this.update(runId, (status) => ({
      ...status,
      state: 'cancelled',
      backends: status.backends.map((backend) => backend.state === 'running' ? { ...backend, state: 'cancelled', finishedAt: new Date().toISOString() } : backend),
    }))
    await this.event(runId, 'run.cancelled')
    return await this.get(runId)
  }

  async deletionImpact(runId: string): Promise<{ directory: string; files: number; bytes: number }> {
    const directory = this.runDir(runId)
    const impact = await directoryImpact(directory)
    return { directory, ...impact }
  }

  async delete(runId: string): Promise<{ files: number; bytes: number }> {
    if (this.active.has(runId)) throw new Error('cannot delete a running benchmark experiment')
    const impact = await this.deletionImpact(runId)
    await rm(impact.directory, { recursive: true, force: false })
    return { files: impact.files, bytes: impact.bytes }
  }

  async events(runId: string, after = -1, limit = 100): Promise<{ events: BenchmarkRunEvent[]; hasMore: boolean }> {
    let text = ''
    try {
      text = await readFile(join(this.runDir(runId), 'events.jsonl'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], hasMore: false }
      throw error
    }
    const all = text.split('\n').filter(Boolean).map((line) => BenchmarkRunEventSchema.parse(JSON.parse(line)))
      .filter((event) => event.seq > after)
    return { events: all.slice(0, limit), hasMore: all.length > limit }
  }

  private async execute(spec: BenchmarkRunSpec, signal: AbortSignal): Promise<void> {
    try {
      if (spec.benchmark !== 'swebench') throw new Error(`orchestrated execution not implemented for ${spec.benchmark}`)
      const instancesJsonl = spec.dataset.instancesJsonl
      if (!instancesJsonl) throw new Error('SWE-bench requires dataset.instancesJsonl')
      await Promise.all(spec.backends.map(async (configured, index) => {
        const key = backendKey(configured.id, configured.model, configured.label, index)
        const backend = getAgentBackend(configured.id)
        const validation = backend.validate(configured)
        if (!validation.ok) throw new Error(`${key}: ${validation.errors.join('; ')}`)
        if (!backend.descriptor.available) throw new Error(`${key}: backend unavailable`)
        const startedAt = new Date().toISOString()
        await this.backendUpdate(spec.runId, key, (current) => ({ ...current, state: 'running', startedAt, error: undefined }))
        await this.event(spec.runId, 'backend.started', {}, configured.id)
        try {
          const backendRoot = join(this.runDir(spec.runId), 'backends', key)
          const result = await runSweBenchAgentPatchRun({
            rootDir: backendRoot,
            runId: 'run',
            dataset: spec.dataset.source,
            ...(spec.dataset.split ? { split: spec.dataset.split } : {}),
            model: configured.model,
            instancesJsonl,
            agentCommand: backend.command(configured),
            ...(spec.dataset.instanceIds ? { instanceIds: spec.dataset.instanceIds } : {}),
            ...(spec.dataset.limit ? { limit: spec.dataset.limit } : {}),
            maxWorkers: spec.execution.maxWorkers,
            timeoutMs: spec.execution.timeoutMs,
            skipCompleted: spec.execution.skipCompleted,
            signal,
          })
          const failed = result.trials.filter((trial) => trial.status === 'failed').length
          const timedOut = result.trials.filter((trial) => trial.status === 'timed_out').length
          await this.backendUpdate(spec.runId, key, (current) => ({
            ...current,
            state: signal.aborted ? 'cancelled' : 'predictions_ready',
            runDir: result.layout.rootDir,
            predictionsPath: result.layout.predictionsPath,
            progressPath: result.layout.progressPath,
            summaryPath: result.layout.summaryPath,
            total: result.trials.length,
            completed: result.trials.length - failed - timedOut,
            failed,
            timedOut,
            finishedAt: new Date().toISOString(),
          }))
          await this.event(spec.runId, 'backend.predictions_ready', { total: result.trials.length, failed, timedOut }, configured.id)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.backendUpdate(spec.runId, key, (current) => ({ ...current, state: signal.aborted ? 'cancelled' : 'failed', error: message, finishedAt: new Date().toISOString() }))
          await this.event(spec.runId, 'backend.failed', { message }, configured.id)
        }
      }))
      const completed = await this.get(spec.runId)
      const failed = completed.status.backends.some((backend) => backend.state === 'failed')
      const cancelled = completed.status.backends.some((backend) => backend.state === 'cancelled')
      await this.update(spec.runId, (status) => ({ ...status, state: cancelled ? 'cancelled' : failed ? 'failed' : 'predictions_ready' }))
      await this.event(spec.runId, cancelled ? 'run.cancelled' : failed ? 'run.failed' : 'run.predictions_ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.update(spec.runId, (status) => ({ ...status, state: signal.aborted ? 'cancelled' : 'failed', error: message }))
      await this.event(spec.runId, signal.aborted ? 'run.cancelled' : 'run.failed', { message })
    }
  }

  private async writeComparison(runId: string): Promise<void> {
    const record = await this.get(runId)
    const comparison = {
      schemaVersion: 1,
      runId,
      generatedAt: new Date().toISOString(),
      backends: record.status.backends.map((backend) => ({
        key: backend.key,
        backendId: backend.backendId,
        model: backend.model,
        total: backend.total ?? 0,
        resolved: backend.resolved ?? 0,
        unresolved: backend.unresolved ?? 0,
        failed: backend.failed ?? 0,
        timedOut: backend.timedOut ?? 0,
      })),
    }
    await atomicJson(join(this.runDir(runId), 'comparison.json'), comparison)
  }

  private async backendUpdate(runId: string, key: string, update: (status: BenchmarkBackendRunStatus) => BenchmarkBackendRunStatus): Promise<void> {
    await this.update(runId, (status) => ({ ...status, backends: status.backends.map((backend) => backend.key === key ? update(backend) : backend) }))
  }

  private async update(runId: string, update: (status: BenchmarkRunStatus) => BenchmarkRunStatus): Promise<void> {
    await this.serialize(runId, async () => {
      const path = join(this.runDir(runId), 'status.json')
      const current = JSON.parse(await readFile(path, 'utf8')) as BenchmarkRunStatus
      await atomicJson(path, { ...update(current), updatedAt: new Date().toISOString() })
    })
  }

  private async event(runId: string, type: string, data: Record<string, unknown> = {}, backendId?: AgentBackendId): Promise<void> {
    await this.serialize(runId, async () => {
      const statusPath = join(this.runDir(runId), 'status.json')
      const status = JSON.parse(await readFile(statusPath, 'utf8')) as BenchmarkRunStatus
      const event = BenchmarkRunEventSchema.parse({ schemaVersion: 1, seq: status.lastSeq + 1, at: new Date().toISOString(), runId, type, ...(backendId ? { backendId } : {}), data })
      await appendFile(join(this.runDir(runId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
      await atomicJson(statusPath, { ...status, lastSeq: event.seq, updatedAt: event.at })
    })
  }

  private async serialize(runId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(runId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.writes.set(runId, next)
    try {
      await next
    } finally {
      if (this.writes.get(runId) === next) this.writes.delete(runId)
    }
  }

  private runDir(runId: string): string {
    return join(this.rootDir, 'benchmark-runs', runId)
  }
}

async function directoryImpact(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const visit = async (path: string): Promise<void> => {
    const info = await stat(path)
    if (!info.isDirectory()) { files += 1; bytes += info.size; return }
    for (const name of await readdir(path)) await visit(join(path, name))
  }
  await visit(directory)
  return { files, bytes }
}

function backendKey(id: AgentBackendId, model: string, label: string | undefined, index: number): string {
  return `${index + 1}-${label ?? `${id}-${model}`}`.replace(/[^A-Za-z0-9._-]+/g, '-')
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
