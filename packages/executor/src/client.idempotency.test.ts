/**
 * Executor tool-call idempotency.
 *
 * Ensures that when the host re-emits the same `tool:call` (which happens
 * on the reconnect path via `redispatchPending`), the executor doesn't
 * re-run the tool. Instead it returns the cached result and re-emits
 * `executor:tool_result` so the host reliably re-observes the settle.
 *
 * Regression guard against duplicate side effects: `bash rm foo`, `write`,
 * anything with observable state  -  a naive re-emit would run twice.
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
    })

    // trigger 'connect' so startExecutor emits the announce (harmless here)
    socket.__trigger('connect')

    // first tool:call  -  real run
    const ack1 = vi.fn()
    socket.__trigger(
      'tool:call',
      { sessionId: 's1', callId: 'call-A', name: 'stub', input: {} },
      ack1,
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(runs).toHaveBeenCalledTimes(1)
    expect(ack1).toHaveBeenCalledWith({ callId: 'call-A', ok: true, content: 'ran-tool' })

    // second tool:call with same callId  -  must NOT re-run, must ack from cache
    const ack2 = vi.fn()
    socket.__trigger(
      'tool:call',
      { sessionId: 's1', callId: 'call-A', name: 'stub', input: {} },
      ack2,
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(runs).toHaveBeenCalledTimes(1) // still 1  -  didn't re-run
    expect(ack2).toHaveBeenCalledWith({ callId: 'call-A', ok: true, content: 'ran-tool' })

    // executor:tool_result should have been emitted twice  -  once for each
    // tool:call  -  so the host reliably re-observes the settle on the
    // reconnect path.
    const resultEmits = socket.__emitted.filter((e) => e.event === 'executor:tool_result')
    expect(resultEmits).toHaveLength(2)
    expect(resultEmits[0]?.args[0]).toMatchObject({ callId: 'call-A', ok: true })
    expect(resultEmits[1]?.args[0]).toMatchObject({ callId: 'call-A', ok: true })
  })

  it('ignores a duplicate tool:call for a call still in flight (no double-spawn)', async () => {
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
    })
    socket.__trigger('connect')

    // fire twice while runner is still awaited
    const ack1 = vi.fn()
    socket.__trigger('tool:call', { sessionId: 's1', callId: 'call-B', name: 'slow', input: {} }, ack1)
    await new Promise((r) => setTimeout(r, 5))

    const ack2 = vi.fn()
    socket.__trigger('tool:call', { sessionId: 's1', callId: 'call-B', name: 'slow', input: {} }, ack2)
    await new Promise((r) => setTimeout(r, 5))

    // ack2 must not fire yet  -  no cached result, still in flight
    expect(ack2).not.toHaveBeenCalled()
    expect(runs).toHaveBeenCalledTimes(1)

    // finish the first call
    resolveRun!('slow-done')
    await new Promise((r) => setTimeout(r, 10))

    expect(ack1).toHaveBeenCalledWith({ callId: 'call-B', ok: true, content: 'slow-done' })
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

  it('resolves permanentError on version_incompatible connect_error', async () => {
    const socket = makeMockSocket()
    const handle = startExecutor({
      host: 'http://x',
      workspaceId: 'ws-ver',
      workspaceName: 'ws-ver',
      executorId: 'ex-ver',
      tools: [],
      ioFactory: (() => socket) as never,
    })

    socket.__trigger('connect_error', new Error('version_incompatible'))

    await expect(handle.permanentError).resolves.toEqual({
      code: 'version_incompatible',
      message: 'version_incompatible',
    })
    expect(socket.connected).toBe(false)
  })
})
