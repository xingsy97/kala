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
  private current: HostRestartAttempt | null = null
  private last: HostRestartAttempt | null = null
  private readonly startedAt: string
  private readonly command: readonly string[]
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly options: RestartCoordinatorOptions) {
    this.startedAt = options.startedAt ?? new Date().toISOString()
    this.command = options.command ?? [process.execPath, ...process.argv.slice(1)]
    this.last = readRestartState(options.statePath)
    if (this.last && this.last.phase === 'restarting') {
      this.last = {
        ...this.last,
        phase: 'completed',
        updatedAt: new Date().toISOString(),
        newPid: process.pid,
      }
      writeRestartState(this.options.statePath, this.last)
    }
  }

  status(): HostRestartStatus {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      current: this.current,
      last: this.current ? this.last : this.last,
    }
  }

  async request(input: RestartRequest = {}): Promise<HostRestartAttempt> {
    if (this.current && !terminalPhase(this.current.phase)) return this.current
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
    this.setCurrent(attempt)
    if (mode === 'force') {
      void this.restartNow()
      return this.current!
    }
    void this.drain(mode, input.timeoutMs)
    return this.current!
  }

  abort(reason = 'restart aborted'): HostRestartAttempt | null {
    if (!this.current || terminalPhase(this.current.phase)) return this.current
    this.clearTimer()
    this.options.loop.endDrain()
    this.setCurrent({
      ...this.current,
      phase: 'aborted',
      updatedAt: new Date().toISOString(),
      error: reason,
      sessions: this.sessionPlans(this.current.mode),
    })
    this.last = this.current
    this.current = null
    return this.last
  }

  async resumeMarkedSessions(): Promise<void> {
    const marker = this.last
    if (!marker || marker.phase !== 'completed') return
    for (const plan of marker.sessions) {
      if (plan.resumeAction === 'continue_turn') {
        await this.options.loop.resumeSession(plan.sessionId).catch(() => false)
      }
    }
  }

  private async drain(mode: HostRestartMode, timeoutMs: number | undefined): Promise<void> {
    if (!this.current) return
    this.options.loop.beginDrain(mode === 'when_idle' ? 'idle' : 'checkpoint')
    this.setCurrent({ ...this.current, phase: 'draining', updatedAt: new Date().toISOString(), sessions: this.sessionPlans(mode) })
    if (timeoutMs && timeoutMs > 0) {
      this.timer = setTimeout(() => {
        this.abort(`restart checkpoint timeout after ${timeoutMs}ms`)
      }, timeoutMs)
    }
    try {
      const plans = this.current.sessions
      await Promise.all(plans.map((plan) => this.options.loop.waitForCheckpoint(plan.sessionId)))
      if (!this.current || this.current.phase === 'aborted') return
      this.clearTimer()
      this.setCurrent({ ...this.current, phase: 'checkpoint_reached', updatedAt: new Date().toISOString(), sessions: this.sessionPlans(mode) })
      await this.restartNow()
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
    }
  }

  private async restartNow(): Promise<void> {
    if (!this.current) return
    this.clearTimer()
    const restarting: HostRestartAttempt = { ...this.current, phase: 'restarting', updatedAt: new Date().toISOString(), sessions: this.sessionPlans(this.current.mode) }
    this.setCurrent(restarting)
    writeRestartState(this.options.statePath, restarting)
    const [cmd, ...args] = this.command
    if (!cmd) {
      this.fail('restart command is empty')
      return
    }
    await this.options.closeServer()
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
    this.options.exitProcess?.(0) ?? process.exit(0)
  }

  private fail(message: string): void {
    if (!this.current) return
    this.clearTimer()
    this.options.loop.endDrain()
    this.setCurrent({ ...this.current, phase: 'failed', updatedAt: new Date().toISOString(), error: message, sessions: this.sessionPlans(this.current.mode) })
    this.last = this.current
    this.current = null
  }

  private setCurrent(attempt: HostRestartAttempt): void {
    this.current = attempt
    writeRestartState(this.options.statePath, attempt)
    this.options.emit(attempt)
  }

  private sessionPlans(mode: HostRestartMode): readonly HostRestartSessionPlan[] {
    return buildRestartSessionPlans({
      records: this.options.store.recordsSnapshot(),
      mode,
      snapshotFor: (sessionId) => this.options.loop.drainSnapshot(sessionId),
    })
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

function terminalPhase(phase: HostRestartAttempt['phase']): boolean {
  return phase === 'completed' || phase === 'aborted' || phase === 'failed'
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

export function defaultRestartStatePath(sessionsDir: string): string {
  return join(dirname(sessionsDir), 'restart-state.json')
}
