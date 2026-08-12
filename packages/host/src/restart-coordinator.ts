import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

import {
  schema,
  type HostRestartAttempt,
  type HostRestartEvent,
  type HostRestartMode,
  type HostRestartReason,
  type HostRestartSessionPlan,
  type HostRestartStatus,
} from '@agent-kernel/shared'
import { ulid } from 'ulid'

import type { LoopDrainSessionSnapshot, LoopHandle } from './loop-types.js'
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
  private frozenPlans = new Map<string, readonly HostRestartSessionPlan[]>()

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
    const requestedMode = input.mode ?? 'checkpoint'
    // A parent `agent` Tool and its child Session are one logical effect. Pausing
    // the child before completion would leave the parent's dispatched Tool
    // outcome ambiguous and replay could spawn a duplicate child. Let that group
    // finish to rest; ordinary LLM/Tool turns still use pre-effect checkpoints.
    const hasActiveSubAgentGroup = this.options.store.recordsSnapshot().some((record) =>
      (record.state.pendingCalls ?? []).some((call) => call.name === 'agent'),
    )
    const mode = requestedMode === 'checkpoint' && hasActiveSubAgentGroup ? 'when_idle' : requestedMode
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
    this.frozenPlans.set(attempt.attemptId, attempt.sessions)
    this.actor.send({ kind: 'request', attempt })
    return this.actor.snapshot().current ?? this.actor.snapshot().last ?? attempt
  }

  commitActivation(attemptId: string): HostRestartAttempt | null {
    const current = this.actor.snapshot().current
    if (!current || current.attemptId !== attemptId || current.phase !== 'checkpoint_reached' || current.reason !== 'deploy') return null
    this.actor.send({
      kind: 'activation_committed',
      attemptId,
      updatedAt: new Date().toISOString(),
      sessions: this.sessionPlansForCurrent(attemptId),
    })
    return this.actor.snapshot().current
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
    let marker = this.actor.snapshot().last
    if (!marker || marker.phase !== 'completed') return
    const receipts = { ...(marker.recoveryReceipts ?? {}) }
    for (const plan of marker.sessions) {
      if (plan.resumeAction !== 'continue_turn' || receipts[plan.sessionId] === 'completed') continue
      receipts[plan.sessionId] = 'running'
      marker = { ...marker, recoveryReceipts: receipts, updatedAt: new Date().toISOString() }
      writeRestartState(this.options.statePath, marker)
      const resumed = await this.options.loop.resumeSession(plan.sessionId).catch(() => false)
      receipts[plan.sessionId] = resumed ? 'completed' : 'failed'
      marker = { ...marker, recoveryReceipts: receipts, updatedAt: new Date().toISOString() }
      writeRestartState(this.options.statePath, marker)
    }
    this.actor.replaceState({ current: null, last: marker })
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
    if (!current || current.attemptId !== attemptId) return []
    const frozen = this.frozenPlans.get(attemptId) ?? current.sessions
    return frozen.map((baseline) => {
      const snapshot = this.options.loop.drainSnapshot(baseline.sessionId)
      const live = planRestartSessionFromBaseline(baseline, snapshot, current.mode)
      return live
    })
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
        sessions: this.sessionPlansForCurrent(command.attemptId),
      })
      return
    }

    if (command.kind === 'wait_for_checkpoints') {
      return Promise.all(command.sessionIds.map((sessionId) => this.options.loop.waitForCheckpoint(sessionId)))
        .then(() => this.options.loop.waitForQuiescence())
        .then(() => {
          const current = this.actor.snapshot().current
          if (!current || current.attemptId !== command.attemptId) return
          send({
            kind: 'checkpoints_reached',
            attemptId: command.attemptId,
            updatedAt: new Date().toISOString(),
            sessions: this.sessionPlansForCurrent(command.attemptId),
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
          sessions: this.sessionPlansForCurrent(command.attemptId),
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
        sessions: this.sessionPlansForCurrent(command.attemptId),
      })
      return
    }

    return this.options.closeServer().then(() => {
      if (this.actor.snapshot().current?.attemptId !== command.attemptId) return
      // The service supervisor owns process replacement. Spawning a detached
      // copy here allowed old and new Hosts to overlap in the same systemd
      // cgroup and append reused cursor values to one Session JSONL.
      if (this.options.exitProcess) this.options.exitProcess(0)
      else process.exit(0)
    })
  }
}

function readRestartState(path: string): HostRestartAttempt | null {
  try {
    if (!existsSync(path)) return null
    const parsed = schema.HostRestartAttemptSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function writeRestartState(path: string, attempt: HostRestartAttempt): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(attempt, null, 2)}\n`, { mode: 0o600 })
  const file = openSync(temp, 'r')
  try {
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
  renameSync(temp, path)
  const directory = openSync(parent, 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

function commandAttemptId(command: RestartWorkflowCommand): string {
  // A failed terminal publication reports another failure event, but the
  // reducer ignores it because no current attempt remains. This avoids a
  // retry loop while keeping persistence/emit failures observable in state.
  return command.kind === 'publish' ? command.attempt.attemptId : command.attemptId
}

function planRestartSessionFromBaseline(
  baseline: HostRestartSessionPlan,
  snapshot: LoopDrainSessionSnapshot,
  mode: HostRestartMode,
): HostRestartSessionPlan {
  const live = buildRestartSessionPlans({
    records: [{ sessionId: baseline.sessionId, state: { status: baseline.initialStatus, cursor: baseline.cursor } }],
    mode,
    snapshotFor: () => snapshot,
  })[0]!
  return {
    ...baseline,
    cursor: live.cursor,
    checkpointStatus: live.checkpointStatus,
    ...(live.checkpointKind ? { checkpointKind: live.checkpointKind } : {}),
    resumeAction: live.resumeAction,
  }
}

export function defaultRestartStatePath(sessionsDir: string): string {
  return join(dirname(sessionsDir), 'restart-state.json')
}
