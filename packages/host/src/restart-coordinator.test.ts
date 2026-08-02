import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostRestartAttempt } from '@agent-kernel/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LoopHandle } from './loop-types.js'
import { RestartCoordinator, type RestartCoordinatorOptions } from './restart-coordinator.js'
import type { SessionStore } from './store/session.js'

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(overrides: Partial<RestartCoordinatorOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'restart-coordinator-'))
  roots.push(root)
  const checkpoint = deferred<ReturnType<LoopHandle['drainSnapshot']>>()
  const events: HostRestartAttempt[] = []
  const loop = {
    beginDrain: vi.fn(),
    endDrain: vi.fn(),
    drainSnapshot: vi.fn((sessionId: string) => ({
      sessionId, status: 'thinking' as const, safe: false, waiting: 'llm' as const, pendingCalls: [], cursor: 3,
    })),
    waitForCheckpoint: vi.fn(() => checkpoint.promise),
    resumeSession: vi.fn(async () => true),
  } as unknown as LoopHandle
  const store = {
    recordsSnapshot: () => [{
      sessionId: 'session-1',
      state: { status: 'thinking' as const, cursor: 3 },
    }],
  } as unknown as SessionStore
  const options: RestartCoordinatorOptions = {
    store,
    loop,
    statePath: join(root, 'restart.json'),
    command: [process.execPath, '-e', 'process.exit(0)'],
    emit: (event) => events.push(event),
    closeServer: vi.fn(async () => undefined),
    exitProcess: vi.fn(),
    ...overrides,
  }
  return { coordinator: new RestartCoordinator(options), checkpoint, events, loop, options }
}

describe('RestartCoordinator', () => {
  it('aborts a timed-out drain once and ignores its late checkpoint', async () => {
    vi.useFakeTimers()
    const { coordinator, checkpoint, events, loop, options } = harness()

    const requested = await coordinator.request({ timeoutMs: 50 })
    expect(coordinator.status().current?.phase).toBe('draining')
    await vi.advanceTimersByTimeAsync(50)

    expect(coordinator.status()).toMatchObject({
      current: null,
      last: { attemptId: requested.attemptId, phase: 'aborted' },
    })
    expect(loop.endDrain).toHaveBeenCalledTimes(1)

    checkpoint.resolve(loop.drainSnapshot('session-1'))
    await Promise.resolve()
    await Promise.resolve()

    expect(coordinator.status().last?.phase).toBe('aborted')
    expect(events.at(-1)?.phase).toBe('aborted')
    expect(options.closeServer).not.toHaveBeenCalled()
  })

  it('returns the same attempt for repeated active requests', async () => {
    const { coordinator, loop } = harness()
    const first = await coordinator.request()
    const second = await coordinator.request({ mode: 'force' })

    expect(second.attemptId).toBe(first.attemptId)
    expect(loop.beginDrain).toHaveBeenCalledTimes(1)
  })

  it('turns checkpoint rejection into a failed terminal attempt', async () => {
    const { coordinator, checkpoint, loop } = harness()
    await coordinator.request()
    checkpoint.reject(new Error('checkpoint unavailable'))
    await vi.waitFor(() => expect(coordinator.status().last?.phase).toBe('failed'))

    expect(coordinator.status()).toMatchObject({
      current: null,
      last: { phase: 'failed', error: 'checkpoint unavailable' },
    })
    expect(loop.endDrain).toHaveBeenCalledTimes(1)
  })

  it('marks a persisted restarting attempt completed on startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-state-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    const persisted: HostRestartAttempt = {
      attemptId: 'persisted',
      phase: 'restarting',
      mode: 'checkpoint',
      reason: 'deploy',
      requestedAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:01.000Z',
      oldPid: 10,
      sessions: [],
    }
    writeFileSync(statePath, JSON.stringify(persisted))
    const { coordinator } = harness({ statePath })

    expect(coordinator.status().last).toMatchObject({
      attemptId: 'persisted', phase: 'completed', newPid: process.pid,
    })
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'completed' })
  })

  it('closes and exits for the service supervisor without spawning an overlapping Host', async () => {
    const { coordinator, options } = harness({ command: ['/path/that/must/not/be-spawned'] })
    await coordinator.request({ mode: 'force' })
    await vi.waitFor(() => expect(options.exitProcess).toHaveBeenCalledWith(0))

    expect(options.closeServer).toHaveBeenCalledOnce()
    expect(coordinator.status().last?.phase).not.toBe('failed')
  })
})
