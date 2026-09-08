import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

import {
  schema,
  type HostRestartAttempt,
  type HostRestartEvent,
  type HostRestartMode,
  type HostRestartReason,
  type HostRestartRecoveryReceipt,
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
  /** Remove externally consumed readiness before the listener starts closing. */
  invalidateReadiness?(): void | Promise<void>
  closeServer(): Promise<void>
  exitProcess?(code: number): void
  shutdownTimeoutMs?: number
  expectedDeployment?: NonNullable<HostRestartAttempt['deployment']>
  queuedMessages?(sessionId: string): number
  hydrateQueue?(sessionId: string): Promise<void>
  drainQueue?(sessionId: string): Promise<void>
  waitForQueueStable?(): Promise<void>
  waitForContinuationDependencies?(plan: HostRestartSessionPlan): Promise<void>
}

export type RestartRequest = {
  mode?: HostRestartMode
  reason?: HostRestartReason
  timeoutMs?: number
  deployment?: NonNullable<HostRestartAttempt['deployment']>
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
      assertDeploymentOwnership(last.deployment, options.expectedDeployment)
      last = {
        ...last,
        phase: 'recovering',
        updatedAt: new Date().toISOString(),
        newPid: process.pid,
        recoveryReceipts: Object.fromEntries(last.sessions.map((session) => [session.sessionId, initialRecoveryReceipt(session)])),
      }
      writeRestartState(this.options.statePath, last)
    } else if (last?.phase === 'recovering' || last?.phase === 'completed' && hasUnsettledRecovery(last)) {
      assertDeploymentOwnership(last.deployment, options.expectedDeployment)
      if (last.phase === 'completed') {
        last = { ...last, phase: 'recovering', updatedAt: new Date().toISOString(), newPid: process.pid }
        writeRestartState(this.options.statePath, last)
      }
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
    if (active) {
      if (input.deployment && !sameDeploymentOwnership(active.deployment, input.deployment)) throw new Error('another deployment owns the active planned restart')
      return active
    }
    const last = this.actor.snapshot().last
    if (input.deployment && last && sameDeploymentOwnership(last.deployment, input.deployment)) return last
    const now = new Date().toISOString()
    const requestedMode = input.mode ?? 'checkpoint'
    const reason = input.reason ?? 'manual'
    // A parent `agent` Tool and its child Session are one logical effect. Pausing
    // the child before completion would leave the parent's dispatched Tool
    // outcome ambiguous and replay could spawn a duplicate child. Let that group
    // finish to rest; ordinary LLM/Tool turns still use pre-effect checkpoints.
    const hasActiveSubAgentGroup = this.options.store.recordsSnapshot().some((record) =>
      (record.state.pendingCalls ?? []).some((call) => call.name === 'agent'),
    )
    const mode = requestedMode === 'checkpoint' && reason !== 'deploy' && hasActiveSubAgentGroup ? 'when_idle' : requestedMode
    const attempt: HostRestartAttempt = {
      attemptId: ulid(),
      phase: 'requested',
      mode,
      reason,
      requestedAt: now,
      updatedAt: now,
      oldPid: process.pid,
      ...(input.deployment ? { deployment: input.deployment } : {}),
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
    if (!current) {
      const last = this.actor.snapshot().last
      return last?.attemptId === attemptId && ['restarting', 'recovering', 'completed'].includes(last.phase) ? last : null
    }
    if (current.attemptId !== attemptId || current.reason !== 'deploy') return null
    if (current.phase === 'restarting') return current
    if (current.phase !== 'checkpoint_reached') return null
    this.actor.send({
      kind: 'activation_committed',
      attemptId,
      updatedAt: new Date().toISOString(),
      sessions: this.sessionPlansForCurrent(attemptId),
    })
    return this.actor.snapshot().current
  }

  abort(reason = 'restart aborted', attemptId?: string): HostRestartAttempt | null {
    const current = this.actor.snapshot().current
    if (!current || attemptId && current.attemptId !== attemptId) return null
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
    if (!marker || marker.phase !== 'recovering') return
    const receipts: Record<string, HostRestartRecoveryReceipt> = Object.fromEntries(marker.sessions.map((plan) => [
      plan.sessionId,
      recoveryReceiptFor(plan, marker!.recoveryReceipts?.[plan.sessionId]),
    ]))
    const persist = (phase: HostRestartAttempt['phase'] = marker!.phase, error?: string): void => {
      marker = {
        ...marker!,
        phase,
        recoveryReceipts: { ...receipts },
        updatedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
      }
      writeRestartState(this.options.statePath, marker)
      this.actor.replaceState({ current: null, last: marker })
    }
    try {
      await Promise.all(marker.sessions.map(async (plan) => await this.options.hydrateQueue?.(plan.sessionId)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const plan of marker.sessions) {
        const receipt = receipts[plan.sessionId]!
        if (receipt.state !== 'settled') receipts[plan.sessionId] = { ...receipt, state: 'failed', error: message }
      }
      persist('failed', `planned continuation queue hydration failed: ${message}`)
      return
    }
    for (const plan of childrenBeforeParents(marker.sessions)) {
      const receipt = receipts[plan.sessionId]!
      if (receipt.state === 'settled') continue
      try {
        // Every frozen participant must be loaded from the shared Session store
        // and fenced at the exact checkpoint cursor before runtime readiness can
        // count it as reconciled. In particular, waiting approvals and resting
        // Sessions do not call resumeSession(), but they are still authoritative
        // migration state and must not be silently marked complete when their
        // JSONL is missing, corrupt, or has advanced outside this attempt.
        const record = this.options.store.get(plan.sessionId) ?? await this.options.store.load(plan.sessionId, { recoverDangling: false })
        if (record.agentRuntime === 'copilot') {
          if (record.state.cursor >= plan.cursor) assertRecoveryCursor(plan, receipt, record.state.cursor)
          receipts[plan.sessionId] = startedRecoveryReceipt(receipt)
          persist()
          const recovered = await this.options.store.load(plan.sessionId)
          if (recovered.state.cursor < plan.cursor) {
            throw new Error(`cursor regressed after external runtime recovery (expected at least ${plan.cursor}, observed ${recovered.state.cursor})`)
          }
          receipts[plan.sessionId] = adoptedRecoveryReceipt(receipts[plan.sessionId]!, recovered.state.cursor)
          persist()
          if ((this.options.queuedMessages?.(plan.sessionId) ?? 0) > 0) {
            await this.options.drainQueue?.(plan.sessionId)
            await this.options.waitForQueueStable?.()
            if ((this.options.queuedMessages?.(plan.sessionId) ?? 0) !== 0) {
              throw new Error('external runtime queue did not drain after interrupted-turn recovery')
            }
          }
          receipts[plan.sessionId] = settledRecoveryReceipt(
            receipts[plan.sessionId]!,
            recovered.state.cursor,
          )
          persist()
          continue
        }
        assertRecoveryCursor(plan, receipt, record.state.cursor)
        if (plan.resumeAction === 'drain_queue') {
          receipts[plan.sessionId] = startedRecoveryReceipt(receipt)
          persist()
          await this.options.drainQueue?.(plan.sessionId)
          await this.options.waitForQueueStable?.()
          if ((this.options.queuedMessages?.(plan.sessionId) ?? 0) !== 0) throw new Error('admitted queue did not drain')
          receipts[plan.sessionId] = settledRecoveryReceipt(receipts[plan.sessionId]!, record.state.cursor)
          persist()
          continue
        }
        if (plan.resumeAction !== 'continue_turn') {
          receipts[plan.sessionId] = settledRecoveryReceipt(receipt, record.state.cursor)
          persist()
          continue
        }
        await this.options.waitForContinuationDependencies?.(plan)
        if (receipt.state === 'pending' || receipt.state === 'running') {
          receipts[plan.sessionId] = startedRecoveryReceipt(receipt)
          persist()
        }
        const latest = receipts[plan.sessionId]!
        if (latest.state === 'adopted' && isRestingStatus(record.state.status)) {
          receipts[plan.sessionId] = settledRecoveryReceipt(latest, record.state.cursor)
          persist()
          continue
        }
        const adopted = deferred<void>()
        const continuation = this.options.loop.resumeSession(plan.sessionId, {
          onStarted: latest.state === 'adopted' ? undefined : () => {
            const observed = this.options.store.get(plan.sessionId)?.state.cursor ?? plan.cursor
            receipts[plan.sessionId] = adoptedRecoveryReceipt(receipts[plan.sessionId]!, observed)
            persist()
            adopted.resolve()
          },
        })
        void continuation.then(async (resumed) => {
          if (!resumed) {
            if (receipts[plan.sessionId]!.state !== 'adopted') throw new Error('runtime refused to resume the frozen checkpoint')
            return
          }
          if ((this.options.queuedMessages?.(plan.sessionId) ?? 0) > 0) {
            await this.options.drainQueue?.(plan.sessionId)
            await this.options.waitForQueueStable?.()
          }
          if ((this.options.queuedMessages?.(plan.sessionId) ?? 0) !== 0) throw new Error('admitted queue did not drain after continuation')
          const observed = this.options.store.get(plan.sessionId)?.state.cursor ?? plan.cursor
          receipts[plan.sessionId] = settledRecoveryReceipt(receipts[plan.sessionId]!, observed)
          persist(recoveryPhase(receipts))
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          const current = receipts[plan.sessionId]!
          receipts[plan.sessionId] = { ...current, state: 'failed', error: message }
          persist('failed', `planned continuation failed for ${plan.sessionId}: ${message}`)
          adopted.reject(error)
        })
        if (latest.state !== 'adopted') await adopted.promise
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        receipts[plan.sessionId] = { ...receipts[plan.sessionId]!, state: 'failed', error: message }
        persist('failed', `planned continuation failed for ${plan.sessionId}: ${message}`)
      }
    }
    const failed = Object.values(receipts).some((receipt) => receipt.state === 'failed')
    const ready = Object.values(receipts).every((receipt) => receipt.state === 'adopted' || receipt.state === 'settled')
    persist(failed || !ready ? 'failed' : recoveryPhase(receipts), failed || ready ? undefined : 'planned continuation did not reach an adopted state')
  }

  private sessionPlans(mode: HostRestartMode): readonly HostRestartSessionPlan[] {
    return this.withQueuePlans(buildRestartSessionPlans({
      records: this.options.store.recordsSnapshot(),
      mode,
      snapshotFor: (sessionId) => this.options.loop.drainSnapshot(sessionId),
    }))
  }

  private sessionPlansForCurrent(attemptId: string): readonly HostRestartSessionPlan[] {
    const current = this.actor.snapshot().current
    if (!current || current.attemptId !== attemptId) return []
    const frozen = this.frozenPlans.get(attemptId) ?? current.sessions
    return this.withQueuePlans(frozen.map((baseline) => {
      const snapshot = this.options.loop.drainSnapshot(baseline.sessionId)
      const live = planRestartSessionFromBaseline(baseline, snapshot, current.mode)
      return live
    }))
  }

  private withQueuePlans(plans: readonly HostRestartSessionPlan[]): readonly HostRestartSessionPlan[] {
    return plans.map((plan) =>
      plan.resumeAction === 'none' && (this.options.queuedMessages?.(plan.sessionId) ?? 0) > 0
        ? { ...plan, resumeAction: 'drain_queue' as const }
        : plan,
    )
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

    return this.shutdownForRestart(command.attemptId)
  }

  private async shutdownForRestart(attemptId: string): Promise<void> {
    await this.options.invalidateReadiness?.()
    const exit = (code: number): void => {
      if (this.options.exitProcess) this.options.exitProcess(code)
      else process.exit(code)
    }
    // Closing Socket.IO or a transport can wedge after the HTTP listener has
    // disappeared. Keep a referenced watchdog so a service never remains
    // systemd-active while permanently returning 502 through Stable Ingress.
    const watchdog = setTimeout(() => exit(1), this.options.shutdownTimeoutMs ?? 30_000)
    try {
      await this.options.closeServer()
      if (this.actor.snapshot().current?.attemptId === attemptId) exit(0)
    } finally {
      clearTimeout(watchdog)
    }
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

function recoveryKey(plan: HostRestartSessionPlan): string {
  return plan.continuationKey ?? `${plan.sessionId}:${plan.cursor}:${plan.checkpointKind ?? plan.resumeAction}`
}

function initialRecoveryReceipt(plan: HostRestartSessionPlan): HostRestartRecoveryReceipt {
  return { continuationKey: recoveryKey(plan), baselineCursor: plan.cursor, state: 'pending' }
}

function recoveryReceiptFor(
  plan: HostRestartSessionPlan,
  receipt: HostRestartRecoveryReceipt | undefined,
): HostRestartRecoveryReceipt {
  const expectedKey = recoveryKey(plan)
  if (!receipt) return initialRecoveryReceipt(plan)
  if (receipt.continuationKey !== expectedKey || receipt.baselineCursor !== plan.cursor) {
    throw new Error(`continuation receipt fence mismatch for ${plan.sessionId}`)
  }
  return receipt
}

function assertRecoveryCursor(plan: HostRestartSessionPlan, receipt: HostRestartRecoveryReceipt, observedCursor: number): void {
  if (observedCursor < plan.cursor) throw new Error(`cursor regressed (expected at least ${plan.cursor}, observed ${observedCursor})`)
  if (observedCursor === plan.cursor) return
  if (receipt.state !== 'adopted' && receipt.state !== 'settled') {
    throw new Error(`cursor advanced before continuation ownership (expected ${plan.cursor}, observed ${observedCursor})`)
  }
  if (receipt.observedCursor !== undefined && observedCursor < receipt.observedCursor) {
    throw new Error(`cursor regressed after continuation ownership (expected at least ${receipt.observedCursor}, observed ${observedCursor})`)
  }
}

function startedRecoveryReceipt(receipt: HostRestartRecoveryReceipt): HostRestartRecoveryReceipt {
  if (receipt.state === 'adopted' || receipt.state === 'settled') return receipt
  return { ...receipt, state: 'running', startedAt: receipt.startedAt ?? new Date().toISOString() }
}

function adoptedRecoveryReceipt(receipt: HostRestartRecoveryReceipt, observedCursor: number): HostRestartRecoveryReceipt {
  return { ...startedRecoveryReceipt(receipt), state: 'adopted', observedCursor: Math.max(receipt.observedCursor ?? receipt.baselineCursor, observedCursor), adoptedAt: receipt.adoptedAt ?? new Date().toISOString() }
}

function settledRecoveryReceipt(receipt: HostRestartRecoveryReceipt, observedCursor: number): HostRestartRecoveryReceipt {
  return { ...receipt, state: 'settled', observedCursor: Math.max(receipt.observedCursor ?? receipt.baselineCursor, observedCursor), settledAt: receipt.settledAt ?? new Date().toISOString() }
}

function recoveryPhase(receipts: Readonly<Record<string, HostRestartRecoveryReceipt>>): HostRestartAttempt['phase'] {
  return Object.values(receipts).every((receipt) => receipt.state === 'adopted' || receipt.state === 'settled') ? 'completed' : 'recovering'
}

function hasUnsettledRecovery(attempt: HostRestartAttempt): boolean {
  const receipts = attempt.recoveryReceipts
  return Boolean(receipts && Object.values(receipts).some((receipt) => receipt.state === 'adopted' || receipt.state === 'running'))
}

function isRestingStatus(status: string): boolean {
  return status === 'idle' || status === 'done' || status === 'error'
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
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

function assertDeploymentOwnership(
  marker: HostRestartAttempt['deployment'],
  expected: HostRestartAttempt['deployment'],
): void {
  if (!marker && !expected) return
  if (!marker || !expected
    || marker.deploymentId !== expected.deploymentId
    || marker.targetReleaseDigest !== expected.targetReleaseDigest
    || marker.expectedRouteGeneration !== expected.expectedRouteGeneration
    || marker.fencingToken !== expected.fencingToken) {
    throw new Error('planned restart deployment ownership mismatch')
  }
}

function sameDeploymentOwnership(
  actual: HostRestartAttempt['deployment'],
  expected: NonNullable<HostRestartAttempt['deployment']>,
): boolean {
  return actual?.deploymentId === expected.deploymentId
    && actual.targetReleaseDigest === expected.targetReleaseDigest
    && actual.expectedRouteGeneration === expected.expectedRouteGeneration
    && actual.fencingToken === expected.fencingToken
}

function childrenBeforeParents(plans: readonly HostRestartSessionPlan[]): readonly HostRestartSessionPlan[] {
  const byId = new Map(plans.map((plan) => [plan.sessionId, plan]))
  const depth = (plan: HostRestartSessionPlan): number => {
    let current = plan
    let value = 0
    const seen = new Set<string>()
    while (current.parentSessionId && byId.has(current.parentSessionId) && !seen.has(current.parentSessionId)) {
      seen.add(current.parentSessionId)
      value += 1
      current = byId.get(current.parentSessionId)!
    }
    return value
  }
  return [...plans].sort((left, right) => depth(right) - depth(left) || left.sessionId.localeCompare(right.sessionId))
}
