/**
 * Executor registry unit tests.
 *
 * We use hand-rolled fake sockets rather than a live socket.io server so we
 * can precisely orchestrate the ordering that matters for reconnect
 * semantics (`tool:call` was emitted  -  old executor died  -  new executor
 * connected  -  who gets the retry?). Real socket.io round-trips add ~ms of
 * jitter that makes ordering-sensitive assertions flaky.
 */

import { describe, expect, it, vi } from 'vitest'

import type { CallToolEffect } from '@agent-kernel/kernel'
import type {
  ExecutorAnnounce,
  ToolCallMessage,
  ToolResultAck,
} from '@agent-kernel/shared'

import { createExecutorRegistry } from './executor.js'

type EmittedCall = {
  event: 'tool:call' | 'tool:cancel'
  payload: ToolCallMessage | { sessionId: string; callId: string }
  ack?: (r: ToolResultAck) => void
}

type FakeSocket = {
  id: string
  emitted: EmittedCall[]
  emit: (event: string, payload: unknown, ack?: (r: ToolResultAck) => void) => void
}

function makeFakeSocket(id: string): FakeSocket {
  const emitted: EmittedCall[] = []
  return {
    id,
    emitted,
    emit(event, payload, ack) {
      emitted.push({
        event: event as EmittedCall['event'],
        payload: payload as EmittedCall['payload'],
        ...(ack ? { ack } : {}),
      })
    },
  }
}

function fakeIo(): unknown {
  // The registry only needs `io` for potential future use; today it's stored
  // and never called. `unknown` cast keeps us honest about not depending on
  // the shape.
  return {}
}

function announceOf(sessionId: string, executorId: string): ExecutorAnnounce {
  return {
    sessionId,
    executorId,
    tools: ['bash'],
    runtime: 'node',
    runtimeVersion: 'test',
  }
}

function callEffect(callId: string, name = 'bash'): CallToolEffect {
  return {
    kind: 'call_tool',
    callId,
    name,
    input: { command: 'echo hi' },
  }
}

describe('ExecutorRegistry', () => {
  it('dispatches a tool call and resolves on ack', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, 5_000)
    const sock = makeFakeSocket('s1')
    reg.attach('sess-1', sock as never, announceOf('sess-1', 'e1'))

    const p = reg.callTool('sess-1', callEffect('c1'))
    expect(sock.emitted).toHaveLength(1)
    expect(sock.emitted[0]!.event).toBe('tool:call')

    // Ack via the callback (host-side path used before executor:tool_result).
    sock.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'hi\n' })
    await expect(p).resolves.toEqual({ ok: true, content: 'hi\n' })
  })

  it('resolves via executor:tool_result when the ack callback is skipped', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, 5_000)
    const sock = makeFakeSocket('s2')
    reg.attach('sess-2', sock as never, announceOf('sess-2', 'e2'))

    const p = reg.callTool('sess-2', callEffect('c1'))
    reg.fulfill('sess-2', {
      sessionId: 'sess-2',
      callId: 'c1',
      ok: true,
      content: 'from tool_result',
    })
    await expect(p).resolves.toEqual({ ok: true, content: 'from tool_result' })
  })

  it('fails pending calls when the executor disconnects with no replacement', async () => {
    const reg = createExecutorRegistry(fakeIo() as never, 5_000)
    const sock = makeFakeSocket('s3')
    reg.attach('sess-3', sock as never, announceOf('sess-3', 'e3'))

    const p = reg.callTool('sess-3', callEffect('c1'))
    reg.detach(sock as never)
    await expect(p).resolves.toEqual({
      ok: false,
      content: 'executor disconnected',
    })
  })

  it('preserves pending calls across a reconnect and re-emits to the new socket', async () => {
    // This is the B7 regression: previously, a network blip mid-tool-call
    // resolved every in-flight call with `ok:false` before the new executor
    // ever got a chance to run them. The kernel then took an entire turn
    // reasoning about a bogus failure.
    const reg = createExecutorRegistry(fakeIo() as never, 5_000)
    const oldSock = makeFakeSocket('old')
    reg.attach('sess-4', oldSock as never, announceOf('sess-4', 'e-old'))

    const p = reg.callTool('sess-4', callEffect('c1', 'bash'))
    expect(oldSock.emitted).toHaveLength(1)

    // Simulate reconnect: new socket announces itself for the same session.
    // Under the old implementation `p` resolves here with a supersede error.
    const newSock = makeFakeSocket('new')
    reg.attach('sess-4', newSock as never, announceOf('sess-4', 'e-new'))

    // The pending promise should NOT be resolved yet.
    let resolvedEarly = false
    void p.then(() => {
      resolvedEarly = true
    })
    await Promise.resolve() // let any spurious microtasks flush
    expect(resolvedEarly).toBe(false)

    // The call must have been re-emitted with the same callId + args.
    expect(newSock.emitted).toHaveLength(1)
    const redispatched = newSock.emitted[0]!
    expect(redispatched.event).toBe('tool:call')
    const rePayload = redispatched.payload as ToolCallMessage
    expect(rePayload.callId).toBe('c1')
    expect(rePayload.name).toBe('bash')
    expect(rePayload.input).toEqual({ command: 'echo hi' })

    // Old executor's late ACK is ignored (its bind was removed).
    oldSock.emitted[0]!.ack!({
      callId: 'c1',
      ok: false,
      content: 'ghost result',
    })

    // New executor completes normally.
    redispatched.ack!({ callId: 'c1', ok: true, content: 'redone' })
    await expect(p).resolves.toEqual({ ok: true, content: 'redone' })
  })

  it('supersede-then-disconnect only fails calls still pending on the new socket', async () => {
    // Belt-and-braces: after redispatch, if the NEW executor also drops
    // without acking, the call must fail cleanly (not hang forever).
    const reg = createExecutorRegistry(fakeIo() as never, 5_000)
    const oldSock = makeFakeSocket('old-2')
    reg.attach('sess-5', oldSock as never, announceOf('sess-5', 'e-old-2'))
    const p = reg.callTool('sess-5', callEffect('c1'))
    const newSock = makeFakeSocket('new-2')
    reg.attach('sess-5', newSock as never, announceOf('sess-5', 'e-new-2'))
    reg.detach(newSock as never)
    await expect(p).resolves.toEqual({
      ok: false,
      content: 'executor disconnected',
    })
  })

  it('detach on a stale socket is a no-op (does not disturb the current bind)', async () => {
    // After supersede the old socket's disconnect event still fires. It must
    // not tear down the new bind's pending calls.
    const reg = createExecutorRegistry(fakeIo() as never, 5_000)
    const oldSock = makeFakeSocket('stale-old')
    reg.attach('sess-6', oldSock as never, announceOf('sess-6', 'e-old-6'))
    const p = reg.callTool('sess-6', callEffect('c1'))
    const newSock = makeFakeSocket('stale-new')
    reg.attach('sess-6', newSock as never, announceOf('sess-6', 'e-new-6'))

    // Simulate the delayed disconnect from the old socket.
    reg.detach(oldSock as never)

    // Pending call still resolvable via the new socket.
    const redispatched = newSock.emitted[newSock.emitted.length - 1]!
    redispatched.ack!({ callId: 'c1', ok: true, content: 'ok' })
    await expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('honours the tool-call timeout when nobody ever acks', async () => {
    vi.useFakeTimers()
    try {
      const reg = createExecutorRegistry(fakeIo() as never, 100)
      const sock = makeFakeSocket('to')
      reg.attach('sess-7', sock as never, announceOf('sess-7', 'e-to'))
      const p = reg.callTool('sess-7', callEffect('c1'))
      await vi.advanceTimersByTimeAsync(150)
      await expect(p).resolves.toEqual({
        ok: false,
        content: 'tool call timed out after 100ms',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelPending emits tool:cancel for every in-flight call', () => {
    const reg = createExecutorRegistry(fakeIo() as never, 5_000)
    const sock = makeFakeSocket('cx')
    reg.attach('sess-8', sock as never, announceOf('sess-8', 'e-cx'))
    void reg.callTool('sess-8', callEffect('c1'))
    void reg.callTool('sess-8', callEffect('c2'))
    reg.cancelPending('sess-8')
    const cancels = sock.emitted.filter((e) => e.event === 'tool:cancel')
    expect(cancels).toHaveLength(2)
    expect(cancels.map((c) => (c.payload as { callId: string }).callId).sort()).toEqual([
      'c1',
      'c2',
    ])
  })
})
