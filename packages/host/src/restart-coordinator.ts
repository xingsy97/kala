import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

import type {
  HostRestartAttempt,
  HostRestartEvent,
  HostRestartMode,
  HostRestartReason,
  HostRestartSessionPlan,
  HostRestartStatus,
} from '@agent-kernel/shared'
import { ulid } from 'ulid'

import type { LoopHandle } from './loop-types.js'
import type { SessionStore } from './store/session.js'
import { buildRestartSessionPlans } from './restart/restart-planner.js'
import {
  transitionRestartWorkflow,
  type RestartWorkflowCommand,
  type RestartWorkflowEvent,
  type RestartWorkflowState,
} from './restart/restart-workflow.js'
import { SerializedActor } from './workflows/serialized-actor.js'

export type RestartCoordinatorOptions = {
  store: SessionStore
  loop: LoopHandle
  statePath: string
  startedAt?: string
  command?: readonly string[]
  emit(event: HostRestartEvent): void
  closeServer(): Promise<void>
  exitProcess?(code: number): void
}

export type RestartRequest = {
  mode?: HostRestartMode
  reason?: HostRestartReason
  timeoutMs?: number
}

export class RestartCoordinator {
  private readonly startedAt: string
  private readonly command: readonly string[]
  private readonly actor: SerializedActor<RestartWorkflowState, RestartWorkflowEvent, RestartWorkflowCommand>
  private timer: { attemptId: string; handle: NodeJS.Timeout } | null = null

  constructor(private readonly options: RestartCoordinatorOptions) {
    this.startedAt = options.startedAt ?? new Date().toISOString()
    this.command = options.command ?? [process.execPath, ...process.argv.slice(1)]
    let last = readRestartState(options.statePath)
    if (last?.phase === 'restarting') {
      last = {
        ...last,
        phase: 'completed',
        updatedAt: new Date().toISOString(),
        newPid: process.pid,
      }
      writeRestartState(this.options.statePath, last)
    }
    this.actor = new SerializedActor({
      initialState: { current: null, last },
      transition: transitionRestartWorkflow,
      run: (command, context) => this.runCommand(command, context.send),
      commandFailed: (command, error) => {
        const attemptId = commandAttemptId(command)
        return {
          kind: 'fail',
          attemptId,
          updatedAt: new Date().toISOString(),
          sessions: this.sessionPlansForCurrent(attemptId),
          error: error instanceof Error ? error.message : String(error),
        }
      },
    })
  }

  status(): HostRestartStatus {
    const state = this.actor.snapshot()
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      current: state.current,
      last: state.last,
    }
  }

  async request(input: RestartRequest = {}): Promise<HostRestartAttempt> {
    const active = this.actor.snapshot().current
    if (active) return active
    const now = new Date().toISOString()
    const mode = input.mode ?? 'checkpoint'
    const attempt: HostRestartAttempt = {
      attemptId: ulid(),
      phase: 'requested',
      mode,
      reason: input.reason ?? 'manual',
      requestedAt: now,
      updatedAt: now,
      oldPid: process.pid,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      command: this.command,
      sessions: this.sessionPlans(mode),
    }
    this.actor.send({ kind: 'request', attempt })
    return this.actor.snapshot().current ?? this.actor.snapshot().last ?? attempt
  }

  abort(reason = 'restart aborted'): HostRestartAttempt | null {
    const current = this.actor.snapshot().current
    if (!current) return null
    this.actor.send({
      kind: 'abort',
      attemptId: current.attemptId,
      updatedAt: new Date().toISOString(),
      error: reason,
      sessions: this.sessionPlans(current.mode),
    })
    return this.actor.snapshot().last
  }

  async resumeMarkedSessions(): Promise<void> {
    const marker = this.actor.snapshot().last
    if (!marker || marker.phase !== 'completed') return
    for (const plan of marker.sessions) {
      if (plan.resumeAction === 'continue_turn') {
        await this.options.loop.resumeSession(plan.sessionId).catch(() => false)
      }
    }
  }

  private sessionPlans(mode: HostRestartMode): readonly HostRestartSessionPlan[] {
    return buildRestartSessionPlans({
      records: this.options.store.recordsSnapshot(),
      mode,
      snapshotFor: (sessionId) => this.options.loop.drainSnapshot(sessionId),
    })
  }

  private sessionPlansForCurrent(attemptId: string): readonly HostRestartSessionPlan[] {
    const current = this.actor.snapshot().current
    return current?.attemptId === attemptId ? this.sessionPlans(current.mode) : []
  }

  private clearTimer(attemptId: string): void {
    if (!this.timer || this.timer.attemptId !== attemptId) return
    clearTimeout(this.timer.handle)
    this.timer = null
  }

  private runCommand(command: RestartWorkflowCommand, send: (event: RestartWorkflowEvent) => void): void | Promise<void> {
    if (command.kind === 'publish') {
      writeRestartState(this.options.statePath, command.attempt)
      this.options.emit(command.attempt)
      return
    }

    if (command.kind === 'begin_drain') {
      this.options.loop.beginDrain(command.mode === 'when_idle' ? 'idle' : 'checkpoint')
      send({
        kind: 'drain_started',
        attemptId: command.attemptId,
        updatedAt: new Date().toISOString(),
        sessions: this.sessionPlans(command.mode),
      })
      return
    }

    if (command.kind === 'wait_for_checkpoints') {
      return Promise.all(command.sessionIds.map((sessionId) => this.options.loop.waitForCheckpoint(sessionId)))
        .then(() => {
          const current = this.actor.snapshot().current
          if (!current || current.attemptId !== command.attemptId) return
          send({
            kind: 'checkpoints_reached',
            attemptId: command.attemptId,
            updatedAt: new Date().toISOString(),
            sessions: this.sessionPlans(current.mode),
          })
        })
    }

    if (command.kind === 'schedule_timeout') {
      this.clearTimer(command.attemptId)
      const handle = setTimeout(() => {
        const current = this.actor.snapshot().current
        if (!current || current.attemptId !== command.attemptId) return
        send({
          kind: 'abort',
          attemptId: command.attemptId,
          updatedAt: new Date().toISOString(),
          sessions: this.sessionPlans(current.mode),
          error: `restart checkpoint timeout after ${command.timeoutMs}ms`,
        })
      }, command.timeoutMs)
      this.timer = { attemptId: command.attemptId, handle }
      return
    }

    if (command.kind === 'clear_timeout') {
      this.clearTimer(command.attemptId)
      return
    }

    if (command.kind === 'end_drain') {
      this.options.loop.endDrain()
      return
    }

    if (command.kind === 'start_restart') {
      const current = this.actor.snapshot().current
      if (!current || current.attemptId !== command.attemptId) return
      send({
        kind: 'restart_started',
        attemptId: command.attemptId,
        updatedAt: new Date().toISOString(),
        sessions: this.sessionPlans(current.mode),
      })
      return
    }

    const [cmd, ...args] = this.command
    if (!cmd) throw new Error('restart command is empty')
    return this.options.closeServer().then(() => {
      if (this.actor.snapshot().current?.attemptId !== command.attemptId) return
      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      })
      return new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('spawn', () => {
          child.removeListener('error', reject)
          child.unref()
          resolve()
        })
      }).then(() => {
        this.options.exitProcess?.(0) ?? process.exit(0)
      })
    })
  }
}

function readRestartState(path: string): HostRestartAttempt | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as HostRestartAttempt
  } catch {
    return null
  }
}

function writeRestartState(path: string, attempt: HostRestartAttempt): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(attempt, null, 2)}\n`, { mode: 0o600 })
}

function commandAttemptId(command: RestartWorkflowCommand): string {
  // A failed terminal publication reports another failure event, but the
  // reducer ignores it because no current attempt remains. This avoids a
  // retry loop while keeping persistence/emit failures observable in state.
  return command.kind === 'publish' ? command.attempt.attemptId : command.attemptId
}

export function defaultRestartStatePath(sessionsDir: string): string {
  return join(dirname(sessionsDir), 'restart-state.json')
}
