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
    waitForQuiescence: vi.fn(async () => undefined),
    resumeSession: vi.fn(async (_sessionId: string, options?: { onStarted?: () => void | Promise<void> }) => {
      await options?.onStarted?.()
      return true
    }),
  } as unknown as LoopHandle
  const store = {
    recordsSnapshot: () => [{
      sessionId: 'session-1',
      state: { status: 'thinking' as const, cursor: 3 },
    }],
    get: (sessionId: string) => sessionId === 'session-1' ? { sessionId, state: { status: 'thinking' as const, cursor: 3 } } : undefined,
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

  it('rejects a different deployment while one planned restart owns the drain', async () => {
    const { coordinator } = harness()
    const first = { deploymentId: 'deployment-owner-0001', targetReleaseDigest: 'a'.repeat(64), expectedRouteGeneration: 1, fencingToken: 'fencing-token-owner-0001' }
    await coordinator.request({ reason: 'deploy', deployment: first })
    await expect(coordinator.request({ reason: 'deploy', deployment: { ...first, deploymentId: 'deployment-owner-0002' } })).rejects.toThrow('another deployment owns')
  })

  it('returns the persisted attempt for a replayed deployment request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-replay-')); roots.push(root)
    const statePath = join(root, 'restart.json')
    const deployment = { deploymentId: 'deployment-owner-0001', targetReleaseDigest: 'a'.repeat(64), expectedRouteGeneration: 1, fencingToken: 'fencing-token-owner-0001' }
    const persisted: HostRestartAttempt = {
      attemptId: 'persisted-replay', phase: 'completed', mode: 'checkpoint', reason: 'deploy', deployment,
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10, newPid: 11, sessions: [],
    }
    writeFileSync(statePath, JSON.stringify(persisted))
    const { coordinator, loop } = harness({ statePath, expectedDeployment: deployment })
    const replayed = await coordinator.request({ reason: 'deploy', deployment })
    expect(replayed).toMatchObject({ attemptId: persisted.attemptId, phase: 'completed' })
    expect(loop.beginDrain).not.toHaveBeenCalled()
  })

  it('does not abort a planned restart owned by a different attempt id', async () => {
    const { coordinator } = harness()
    const active = await coordinator.request({ reason: 'deploy' })
    expect(coordinator.abort('stale abort', 'different-attempt')).toBeNull()
    expect(coordinator.status().current?.attemptId).toBe(active.attemptId)
  })

  it('upgrades an active parent/child agent Tool group to when_idle', async () => {
    const store = {
      recordsSnapshot: () => [{
        sessionId: 'parent',
        state: {
          status: 'executing_tools' as const,
          cursor: 4,
          pendingCalls: [{ callId: 'agent-call', name: 'agent', input: {}, status: 'dispatched' as const }],
        },
      }],
    } as unknown as SessionStore
    const { coordinator, loop } = harness({ store })
    const result = await coordinator.request({ mode: 'checkpoint' })
    expect(result.mode).toBe('when_idle')
    expect(loop.beginDrain).toHaveBeenCalledWith('idle')
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

  it('holds a persisted restarting attempt in recovery until continuations settle', async () => {
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
      attemptId: 'persisted', phase: 'recovering', newPid: process.pid,
    })
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'recovering' })
    await coordinator.resumeMarkedSessions()
    expect(coordinator.status().last).toMatchObject({ phase: 'completed' })
  })

  it('closes and exits for the service supervisor without spawning an overlapping Host', async () => {
    const { coordinator, options } = harness({ command: ['/path/that/must/not/be-spawned'] })
    await coordinator.request({ mode: 'force' })
    await vi.waitFor(() => expect(options.exitProcess).toHaveBeenCalledWith(0))

    expect(options.closeServer).toHaveBeenCalledOnce()
    expect(coordinator.status().last?.phase).not.toBe('failed')
  })

  it('invalidates readiness and force-exits when server close wedges', async () => {
    vi.useFakeTimers()
    const never = deferred<void>()
    const invalidateReadiness = vi.fn()
    const { coordinator, options } = harness({
      invalidateReadiness,
      closeServer: vi.fn(() => never.promise),
      shutdownTimeoutMs: 50,
    })
    await coordinator.request({ mode: 'force' })
    await vi.advanceTimersByTimeAsync(50)
    expect(invalidateReadiness).toHaveBeenCalledOnce()
    expect(options.exitProcess).toHaveBeenCalledWith(1)
  })

  it('persists continuation receipts and does not resume a completed participant twice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-receipts-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    const persisted: HostRestartAttempt = {
      attemptId: 'receipt-attempt',
      phase: 'restarting',
      mode: 'checkpoint',
      reason: 'deploy',
      requestedAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:01.000Z',
      oldPid: 10,
      sessions: [{
        sessionId: 'session-1', cursor: 3, initialStatus: 'thinking',
        checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn',
      }],
    }
    writeFileSync(statePath, JSON.stringify(persisted))
    const first = harness({ statePath })
    await first.coordinator.resumeMarkedSessions()
    expect(first.loop.resumeSession).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(statePath, 'utf8')).recoveryReceipts).toMatchObject({ 'session-1': { state: 'settled', baselineCursor: 3 } })

    const second = harness({ statePath })
    await second.coordinator.resumeMarkedSessions()
    expect(second.loop.resumeSession).not.toHaveBeenCalled()
  })

  it('marks a persisted idle queue for candidate-side drain and completes it once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-queue-receipt-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    const persisted: HostRestartAttempt = {
      attemptId: 'queue-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:01.000Z', oldPid: 10,
      sessions: [{ sessionId: 'session-1', cursor: 3, initialStatus: 'done', checkpointStatus: 'safe', checkpointKind: 'resting', resumeAction: 'drain_queue' }],
    }
    writeFileSync(statePath, JSON.stringify(persisted))
    let pending = 1
    const hydrateQueue = vi.fn(async () => undefined)
    const drainQueue = vi.fn(async () => { pending = 0 })
    const first = harness({ statePath, queuedMessages: () => pending, hydrateQueue, drainQueue, waitForQueueStable: async () => undefined })
    await first.coordinator.resumeMarkedSessions()
    expect(hydrateQueue).toHaveBeenCalledWith('session-1')
    expect(drainQueue).toHaveBeenCalledOnce()
    expect(first.loop.resumeSession).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'completed', recoveryReceipts: { 'session-1': { state: 'settled' } } })

    const second = harness({ statePath, queuedMessages: () => pending, hydrateQueue, drainQueue, waitForQueueStable: async () => undefined })
    await second.coordinator.resumeMarkedSessions()
    expect(drainQueue).toHaveBeenCalledOnce()
  })

  it('waits for candidate dependencies before resuming a pre-dispatch continuation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-dependency-wait-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'dependency-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10,
      sessions: [{ sessionId: 'session-1', cursor: 3, initialStatus: 'executing_tools', checkpointStatus: 'safe', checkpointKind: 'before_tool_dispatch', resumeAction: 'continue_turn' }],
    } satisfies HostRestartAttempt))
    const dependency = deferred<void>()
    const waitForContinuationDependencies = vi.fn(() => dependency.promise)
    const { coordinator, loop } = harness({ statePath, waitForContinuationDependencies })
    const recovery = coordinator.resumeMarkedSessions()
    await vi.waitFor(() => expect(waitForContinuationDependencies).toHaveBeenCalledOnce())
    expect(loop.resumeSession).not.toHaveBeenCalled()
    dependency.resolve()
    await recovery
    expect(loop.resumeSession).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'completed', recoveryReceipts: { 'session-1': { state: 'settled' } } })
  })

  it('persists a failed terminal receipt when a continuation dependency cannot recover', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-dependency-failure-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'dependency-failure-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10,
      sessions: [{ sessionId: 'session-1', cursor: 3, initialStatus: 'executing_tools', checkpointStatus: 'safe', checkpointKind: 'before_tool_dispatch', resumeAction: 'continue_turn' }],
    } satisfies HostRestartAttempt))
    const { coordinator, loop } = harness({
      statePath,
      waitForContinuationDependencies: async () => { throw new Error('Executor reconnect deadline exceeded') },
    })
    await expect(coordinator.resumeMarkedSessions()).resolves.toBeUndefined()
    expect(loop.resumeSession).not.toHaveBeenCalled()
    expect(coordinator.status().last).toMatchObject({
      phase: 'failed',
      recoveryReceipts: { 'session-1': { state: 'failed' } },
      error: 'planned continuation failed for session-1: Executor reconnect deadline exceeded',
    })
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'failed',
      recoveryReceipts: { 'session-1': { state: 'failed' } },
    })
  })

  it('settles child continuations before their parent after replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-child-parent-order-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    const plans: HostRestartAttempt['sessions'] = [
      { sessionId: 'parent', cursor: 4, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn' },
      { sessionId: 'child', parentSessionId: 'parent', parentCallId: 'agent-call', cursor: 7, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn' },
    ]
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'child-parent-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10, sessions: plans,
    } satisfies HostRestartAttempt))
    const order: string[] = []
    const store = {
      recordsSnapshot: () => [],
      get: (sessionId: string) => ({ sessionId, state: { status: 'thinking' as const, cursor: sessionId === 'child' ? 7 : 4 } }),
    } as unknown as SessionStore
    const loop = { resumeSession: vi.fn(async (sessionId: string, options?: { onStarted?: () => void | Promise<void> }) => { await options?.onStarted?.(); order.push(sessionId); return true }) } as unknown as LoopHandle
    const { coordinator } = harness({ statePath, store, loop })
    await coordinator.resumeMarkedSessions()
    expect(order).toEqual(['child', 'parent'])
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'completed', recoveryReceipts: { child: { state: 'settled' }, parent: { state: 'settled' } },
    })
  })

  it('loads and cursor-fences a waiting Approval before marking it reconciled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-approval-receipt-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'approval-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10,
      sessions: [{ sessionId: 'approval-session', cursor: 8, initialStatus: 'awaiting_approval', checkpointStatus: 'safe', checkpointKind: 'waiting_for_approval', resumeAction: 'wait_for_approval' }],
    } satisfies HostRestartAttempt))
    const load = vi.fn(async () => ({ sessionId: 'approval-session', agentRuntime: 'kernel' as const, state: { status: 'awaiting_approval' as const, cursor: 8 } }))
    const store = { recordsSnapshot: () => [], get: () => undefined, load } as unknown as SessionStore
    const { coordinator, loop } = harness({ statePath, store })
    await coordinator.resumeMarkedSessions()
    expect(load).toHaveBeenCalledWith('approval-session', { recoverDangling: false })
    expect(loop.resumeSession).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'completed', recoveryReceipts: { 'approval-session': { state: 'settled' } },
    })
  })

  it('recovers an external runtime participant without entering the Kernel Loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-copilot-receipt-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'copilot-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10,
      sessions: [{ sessionId: 'copilot-session', cursor: 8, initialStatus: 'awaiting_approval', checkpointStatus: 'safe', checkpointKind: 'waiting_for_approval', resumeAction: 'wait_for_approval' }],
    } satisfies HostRestartAttempt))
    const load = vi.fn(async (_sessionId: string, options?: { recoverDangling?: boolean }) => options?.recoverDangling === false
      ? { sessionId: 'copilot-session', agentRuntime: 'copilot' as const, state: { status: 'awaiting_approval' as const, cursor: 8 } }
      : { sessionId: 'copilot-session', agentRuntime: 'copilot' as const, state: { status: 'error' as const, cursor: 9 } })
    const store = { recordsSnapshot: () => [], get: () => undefined, load } as unknown as SessionStore
    const { coordinator, loop } = harness({ statePath, store })

    await coordinator.resumeMarkedSessions()

    expect(load).toHaveBeenNthCalledWith(1, 'copilot-session', { recoverDangling: false })
    expect(load).toHaveBeenNthCalledWith(2, 'copilot-session')
    expect(loop.resumeSession).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'completed',
      recoveryReceipts: { 'copilot-session': { state: 'settled', observedCursor: 9 } },
    })
  })

  it('fails closed when a non-resuming participant cannot be loaded at its frozen cursor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-resting-fence-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'resting-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10,
      sessions: [{ sessionId: 'resting-session', cursor: 5, initialStatus: 'done', checkpointStatus: 'safe', checkpointKind: 'resting', resumeAction: 'none' }],
    } satisfies HostRestartAttempt))
    const store = { recordsSnapshot: () => [], get: () => undefined, load: vi.fn(async () => { throw new Error('missing JSONL') }) } as unknown as SessionStore
    const { coordinator, loop } = harness({ statePath, store })
    await coordinator.resumeMarkedSessions()
    expect(loop.resumeSession).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'failed',
      recoveryReceipts: { 'resting-session': { state: 'failed' } },
      error: 'planned continuation failed for resting-session: missing JSONL',
    })
  })

  it('publishes readiness after adoption without waiting for a self-deployment turn to settle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-self-deploy-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'self-deploy-attempt', phase: 'restarting', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10,
      sessions: [{ sessionId: 'session-1', cursor: 3, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn', continuationKey: 'self-deploy-key' }],
    } satisfies HostRestartAttempt))
    const settle = deferred<boolean>()
    const loop = {
      resumeSession: vi.fn(async (_sessionId: string, options?: { onStarted?: () => void | Promise<void> }) => {
        await options?.onStarted?.()
        return await settle.promise
      }),
    } as unknown as LoopHandle
    const { coordinator } = harness({ statePath, loop })

    await expect(coordinator.resumeMarkedSessions()).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'completed', recoveryReceipts: { 'session-1': { state: 'adopted', continuationKey: 'self-deploy-key' } },
    })
    settle.resolve(true)
    await vi.waitFor(() => expect(JSON.parse(readFileSync(statePath, 'utf8')).recoveryReceipts['session-1'].state).toBe('settled'))
  })

  it('adopts monotonic progress after replacement without replaying its continuation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-adopt-progress-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'adopt-progress', phase: 'completed', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10,
      sessions: [{ sessionId: 'session-1', cursor: 3, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn', continuationKey: 'adopt-progress-key' }],
      recoveryReceipts: { 'session-1': { continuationKey: 'adopt-progress-key', baselineCursor: 3, state: 'adopted', observedCursor: 3 } },
    } satisfies HostRestartAttempt))
    const store = { recordsSnapshot: () => [], get: () => ({ sessionId: 'session-1', state: { status: 'done' as const, cursor: 9 } }) } as unknown as SessionStore
    const loop = { resumeSession: vi.fn() } as unknown as LoopHandle
    const { coordinator } = harness({ statePath, store, loop })

    await coordinator.resumeMarkedSessions()
    expect(loop.resumeSession).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'completed', recoveryReceipts: { 'session-1': { state: 'settled', observedCursor: 9 } } })
  })

  it('fails closed when the cursor advanced without a durable adoption fence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-unowned-progress-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'unowned-progress', phase: 'recovering', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10,
      sessions: [{ sessionId: 'session-1', cursor: 3, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn', continuationKey: 'unowned-progress-key' }],
      recoveryReceipts: { 'session-1': { continuationKey: 'unowned-progress-key', baselineCursor: 3, state: 'running' } },
    } satisfies HostRestartAttempt))
    const store = { recordsSnapshot: () => [], get: () => ({ sessionId: 'session-1', state: { status: 'thinking' as const, cursor: 4 } }) } as unknown as SessionStore
    const loop = { resumeSession: vi.fn() } as unknown as LoopHandle
    const { coordinator } = harness({ statePath, store, loop })

    await coordinator.resumeMarkedSessions()
    expect(loop.resumeSession).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      phase: 'failed', recoveryReceipts: { 'session-1': { state: 'failed' } },
      error: 'planned continuation failed for session-1: cursor advanced before continuation ownership (expected 3, observed 4)',
    })
  })

  it('fails closed on cursor regression after durable adoption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restart-cursor-regression-'))
    roots.push(root)
    const statePath = join(root, 'restart.json')
    writeFileSync(statePath, JSON.stringify({
      attemptId: 'cursor-regression', phase: 'recovering', mode: 'checkpoint', reason: 'deploy',
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), oldPid: 10,
      sessions: [{ sessionId: 'session-1', cursor: 3, initialStatus: 'thinking', checkpointStatus: 'safe', checkpointKind: 'before_llm', resumeAction: 'continue_turn', continuationKey: 'cursor-regression-key' }],
      recoveryReceipts: { 'session-1': { continuationKey: 'cursor-regression-key', baselineCursor: 3, state: 'adopted', observedCursor: 8 } },
    } satisfies HostRestartAttempt))
    const store = { recordsSnapshot: () => [], get: () => ({ sessionId: 'session-1', state: { status: 'thinking' as const, cursor: 7 } }) } as unknown as SessionStore
    const { coordinator } = harness({ statePath, store })

    await coordinator.resumeMarkedSessions()
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'failed', recoveryReceipts: { 'session-1': { state: 'failed' } } })
  })
})
