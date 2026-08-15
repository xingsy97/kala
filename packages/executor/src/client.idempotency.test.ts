/**
 * Executor tool-call idempotency.
 *
 * Ensures that when the host re-emits the same `tool:call` (which happens
 * on the reconnect path via `redispatchPending`), the executor doesn't
 * re-run the tool. Instead it returns the cached result via ack.
 *
 * Regression guard against duplicate side effects: `bash rm foo`, `write`,
 * anything with observable state — a naive re-emit would run twice.
 */

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

import { startExecutor } from './client.js'
import type { Tool } from './tools/registry.js'

type Handler = (...args: unknown[]) => void

/**
 * Minimal socket.io-client mock that exposes `emit` / `on` / `disconnect`
 * with the shape startExecutor uses. Also lets the test synthesize
 * inbound events by invoking the registered handler manually.
 */
function makeMockSocket() {
  const emitter = new EventEmitter()
  const managerEmitter = new EventEmitter()
  const emitted: Array<{ event: string; args: unknown[] }> = []
  const socket = {
    connected: true,
    auth: undefined as unknown,
    // Socket.IO client exposes `.io` = the underlying Manager, which also
    // implements EventEmitter. Real code subscribes to `reconnect_failed`
    // there. The test doesn't need to emit those, but the attach must not
    // throw.
    io: managerEmitter,
    emit: (event: string, ...args: unknown[]) => {
      emitted.push({ event, args })
      return true
    },
    on: (event: string, handler: Handler) => {
      emitter.on(event, handler)
    },
    off: (event: string, handler: Handler) => {
      emitter.off(event, handler)
    },
    disconnect: () => {
      socket.connected = false
    },
    __trigger(event: string, ...args: unknown[]) {
      emitter.emit(event, ...args)
    },
    __emitted: emitted,
  }
  return socket
}

describe('executor idempotency', () => {
  it('serves a duplicate tool:call from cache without re-running the tool', async () => {
    const runs = vi.fn(async () => 'ran-tool')
    const testTool: Tool = { name: 'stub', run: runs }
    const socket = makeMockSocket()

    startExecutor({
      host: 'http://x',
      workspaceId: 'ws-idem',
      workspaceName: 'ws-idem',
      executorId: 'ex-idem',
      tools: [testTool],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })

    // trigger 'connect' so startExecutor emits the announce (harmless here)
    socket.__trigger('connect')

    // first tool:call — real run
    const ack1 = vi.fn()
    socket.__trigger(
      'tool:call',
      { sessionId: 's1', callId: 'call-A', name: 'stub', input: {} },
      ack1,
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(runs).toHaveBeenCalledTimes(1)
    expect(ack1).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-A', ok: true, content: 'ran-tool', durationMs: expect.any(Number) }))

    // second tool:call with same callId — must NOT re-run, must ack from cache
    const ack2 = vi.fn()
    socket.__trigger(
      'tool:call',
      { sessionId: 's1', callId: 'call-A', name: 'stub', input: {} },
      ack2,
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(runs).toHaveBeenCalledTimes(1) // still 1 — didn't re-run
    expect(ack2).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-A', ok: true, content: 'ran-tool', durationMs: expect.any(Number) }))
  })

  it('does not collide when two Sessions reuse the same provider callId', async () => {
    const runs = vi.fn(async (_input, context) => `ran-${context.sessionId}`)
    const socket = makeMockSocket()
    startExecutor({
      host: 'http://x', workspaceId: 'ws-scoped', workspaceName: 'ws-scoped', executorId: 'ex-scoped',
      tools: [{ name: 'stub', run: runs }], ioFactory: (() => socket) as never, receiptStorePath: false,
    })
    socket.__trigger('connect')

    const first = vi.fn()
    socket.__trigger('tool:call', { sessionId: 'session-a', callId: 'same-call', name: 'stub', input: {} }, first)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = vi.fn()
    socket.__trigger('tool:call', { sessionId: 'session-b', callId: 'same-call', name: 'stub', input: {} }, second)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(runs).toHaveBeenCalledTimes(2)
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ callId: 'same-call', ok: true, content: 'ran-session-a', durationMs: expect.any(Number) }))
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ callId: 'same-call', ok: true, content: 'ran-session-b', durationMs: expect.any(Number) }))
  })

  it('fans out completion to duplicate in-flight ACK callbacks without double-spawn', async () => {
    let resolveRun: ((v: string) => void) | null = null
    const runs = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRun = resolve
        }),
    )
    const testTool: Tool = { name: 'slow', run: runs }
    const socket = makeMockSocket()

    startExecutor({
      host: 'http://x',
      workspaceId: 'ws-slow',
      workspaceName: 'ws-slow',
      executorId: 'ex-slow',
      tools: [testTool],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })
    socket.__trigger('connect')

    // fire twice while runner is still awaited
    const ack1 = vi.fn()
    socket.__trigger('tool:call', { sessionId: 's1', callId: 'call-B', name: 'slow', input: {} }, ack1)
    await new Promise((r) => setTimeout(r, 5))

    const ack2 = vi.fn()
    socket.__trigger('tool:call', { sessionId: 's1', callId: 'call-B', name: 'slow', input: {} }, ack2)
    await new Promise((r) => setTimeout(r, 5))

    // Neither callback fires until the single invocation completes.
    expect(ack2).not.toHaveBeenCalled()
    expect(runs).toHaveBeenCalledTimes(1)

    // Finish once; both the old and replacement socket callbacks receive the
    // result so the host cannot strand pending ownership after reconnect.
    resolveRun!('slow-done')
    await new Promise((r) => setTimeout(r, 10))

    const expected = expect.objectContaining({ callId: 'call-B', ok: true, content: 'slow-done', durationMs: expect.any(Number) })
    expect(ack1).toHaveBeenCalledWith(expected)
    expect(ack2).toHaveBeenCalledWith(expected)
    expect(runs).toHaveBeenCalledTimes(1) // never re-ran
  })

  it('resolves permanentError on executor:host_reject', async () => {
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://x',
      workspaceId: 'ws-reject',
      workspaceName: 'ws-reject',
      executorId: 'ex-reject',
      tools: [],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })
    socket.__trigger('connect')

    // Simulate host emitting an inbound executor:host_reject.
    socket.__trigger('executor:host_reject', {
      code: 'workspace_id_conflict',
      message: 'someone else already has this workspaceId',
    })

    await expect(handle.permanentError).resolves.toEqual({
      code: 'workspace_id_conflict',
      message: 'someone else already has this workspaceId',
    })
    // The permanent-error handler should have disconnected the socket to
    // stop socket.io's own reconnection loop.
    expect(socket.connected).toBe(false)
  })

  it('passes executor:welcome long-term token to the persistence callback', () => {
    const socket = makeMockSocket()
    const onToken = vi.fn()
    startExecutor({
      host: 'http://x',
      workspaceId: 'ws-welcome',
      workspaceName: 'ws-welcome',
      executorId: 'ex-welcome',
      tools: [],
      onToken,
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })

    socket.__trigger('executor:welcome', { token: 'ak_exec_saved', workspaceId: 'ws-welcome' })

    expect(onToken).toHaveBeenCalledWith('ak_exec_saved')
    expect(socket.auth).toEqual({
      role: 'executor',
      clientVersion: expect.any(String),
      token: 'ak_exec_saved',
    })
  })

  it('resolves permanentError on version_incompatible connect_error', async () => {
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://x',
      workspaceId: 'ws-ver',
      workspaceName: 'ws-ver',
      executorId: 'ex-ver',
      tools: [],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })

    socket.__trigger('connect_error', new Error('version_incompatible'))

    await expect(handle.permanentError).resolves.toEqual({
      code: 'version_incompatible',
      message: 'version_incompatible',
    })
    expect(socket.connected).toBe(false)
  })

  it('keeps the executor alive when socket.io reports reconnect_failed', async () => {
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://x',
      workspaceId: 'ws-retry',
      workspaceName: 'ws-retry',
      executorId: 'ex-retry',
      tools: [],
      ioFactory: (() => socket) as never,
      receiptStorePath: false,
    })

    const resolved = await Promise.race([
      handle.permanentError.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ])
    socket.io.emit('reconnect_failed')
    const resolvedAfterFailure = await Promise.race([
      handle.permanentError.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ])

    expect(resolved).toBe(false)
    expect(resolvedAfterFailure).toBe(false)
    expect(socket.connected).toBe(true)
    handle.close()
  })

  it('configures socket.io to retry forever with a bounded one minute backoff', () => {
    const socket = makeMockSocket()
    const ioFactory = vi.fn(() => socket)

    startExecutor({
      host: 'http://x',
      workspaceId: 'ws-retry-config',
      workspaceName: 'ws-retry-config',
      executorId: 'ex-retry-config',
      tools: [],
      ioFactory: ioFactory as never,
    })

    expect(ioFactory).toHaveBeenCalledWith(
      'http://x/executor',
      expect.objectContaining({
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 60_000,
        reconnectionAttempts: Infinity,
      }),
    )
  })
})
