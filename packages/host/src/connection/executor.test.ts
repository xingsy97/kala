/**
 * Executor registry unit tests.
 *
 * We use hand-rolled fake sockets rather than a live socket.io server so we
 * can precisely orchestrate the ordering that matters for reconnect
 * semantics (`tool:call` was emitted → old executor died → new executor
 * connected → who gets the retry?). Real socket.io round-trips add ~ms of
 * jitter that makes ordering-sensitive assertions flaky.
 */

import { describe, expect, it, vi } from 'vitest'

import type { CallToolEffect } from '@agent-kernel/kernel'
import type {
  ExecutorAnnounce,
  ToolCallMessage,
  ToolResultAck,
} from '@agent-kernel/shared'

import {
  createExecutorRegistry,
  type WorkspaceResolver,
} from './executor.js'

type EmittedCall = {
  event:
    | 'tool:call'
    | 'tool:cancel'
    | 'session:error'
    | 'executor:host_reject'
  payload:
    | ToolCallMessage
    | { sessionId: string; callId: string }
    | Record<string, unknown>
  ack?: (r: ToolResultAck) => void
}

type FakeSocket = {
  id: string
  emitted: EmittedCall[]
  connected: boolean
  emit: (event: string, payload: unknown, ack?: (r: ToolResultAck) => void) => void
  disconnect: (close?: boolean) => void
}

function makeFakeSocket(id: string): FakeSocket {
  const emitted: EmittedCall[] = []
  const sock: FakeSocket = {
    id,
    emitted,
    connected: true,
    emit(event, payload, ack) {
      emitted.push({
        event: event as EmittedCall['event'],
        payload: payload as EmittedCall['payload'],
        ...(ack ? { ack } : {}),
      })
    },
    disconnect() {
      sock.connected = false
    },
  }
  return sock
}

function fakeIo(): unknown {
  return {}
}

/**
 * Test-only resolver. Real deployments back this with `SessionStore.get`, but
 * that would drag the whole store into every unit test. This map lets each
 * test express the invariant it cares about (session S is bound to
 * workspace W) without file I/O.
 */
function makeResolver(bindings: Record<string, string | undefined> = {}): WorkspaceResolver {
  return {
    workspaceIdFor: (sid) => bindings[sid],
  }
}

function announceOf(
  executorId: string,
  workspaceId = 'ws-default',
  workspaceName = 'default-workspace',
): ExecutorAnnounce {
  return {
    executorId,
    workspaceId,
    workspaceName,
    tools: ['bash'],
    runtime: 'node',
    runtimeVersion: 'test',
  }
}

function callEffect(
  callId: string,
  name = 'bash',
  cwd?: string,
  input: Record<string, unknown> = { command: 'echo hi' },
): CallToolEffect {
  return {
    kind: 'call_tool',
    callId,
    name,
    input,
    ...(cwd !== undefined ? { cwd } : {}),
  }
}

describe('ExecutorRegistry', () => {
  it('dispatches a tool call and resolves on ack', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-1': 'ws-default' }),
      5_000,
    )
    const sock = makeFakeSocket('s1')
    reg.attach(sock as never, announceOf('e1'))

    const p = reg.callTool('sess-1', callEffect('c1', 'bash', '/tmp/work'))
    expect(sock.emitted).toHaveLength(1)
    expect(sock.emitted[0]!.event).toBe('tool:call')
    const payload = sock.emitted[0]!.payload as ToolCallMessage
    expect(payload.cwd).toBe('/tmp/work')
    expect(payload.ackTimeoutMs).toBe(5_000)
    expect('timeoutMs' in payload).toBe(false)

    // Ack via the callback — this is the sole settle path now that the
    // redundant executor:tool_result event has been removed.
    sock.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'hi\n' })
    await expect(p).resolves.toEqual({ ok: true, content: 'hi\n' })
  })

  it('keeps bash business timeout in input and stretches only the host ack timeout', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-long': 'ws-default' }),
      60_000,
    )
    const sock = makeFakeSocket('s-long')
    reg.attach(sock as never, announceOf('e-long'))

    const p = reg.callTool('sess-long', callEffect('c-long', 'bash', undefined, {
      command: 'pnpm test',
      timeout_seconds: 600,
    }))
    const payload = sock.emitted[0]!.payload as ToolCallMessage
    expect(payload.input).toEqual({ command: 'pnpm test', timeout_seconds: 600 })
    expect(payload.ackTimeoutMs).toBe(660_000)
    expect('timeoutMs' in payload).toBe(false)

    sock.emitted[0]!.ack!({ callId: 'c-long', ok: true, content: 'ok' })
    await expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('fails pending calls when the executor disconnects with no replacement', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-3': 'ws-default' }),
      5_000,
      undefined,
      0, // no grace window — assert instant-detach semantics
    )
    const sock = makeFakeSocket('s3')
    reg.attach(sock as never, announceOf('e3'))

    const p = reg.callTool('sess-3', callEffect('c1'))
    reg.detach(sock as never)
    await expect(p).resolves.toEqual({
      ok: false,
      content: 'executor disconnected',
    })
  })

  it('preserves pending calls across a reconnect and re-emits to the new socket', async () => {
    // B7 regression: a network blip mid-tool-call previously failed every
    // in-flight call before the new executor got to run them. Session
    // identity is baked into the pending record so redispatch delivers the
    // same sessionId onward.
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-4': 'ws-default' }),
      5_000,
    )
    const oldSock = makeFakeSocket('old')
    reg.attach(oldSock as never, announceOf('e-reconnect'))

    const p = reg.callTool('sess-4', callEffect('c1', 'bash', '/tmp/retry'))
    expect(oldSock.emitted).toHaveLength(1)

    // Reconnect: same executorId, fresh socket.
    const newSock = makeFakeSocket('new')
    reg.attach(newSock as never, announceOf('e-reconnect'))

    let resolvedEarly = false
    void p.then(() => {
      resolvedEarly = true
    })
    await Promise.resolve()
    expect(resolvedEarly).toBe(false)

    expect(newSock.emitted).toHaveLength(1)
    const redispatched = newSock.emitted[0]!
    expect(redispatched.event).toBe('tool:call')
    const rePayload = redispatched.payload as ToolCallMessage
    expect(rePayload.callId).toBe('c1')
    expect(rePayload.sessionId).toBe('sess-4')
    expect(rePayload.name).toBe('bash')
    expect(rePayload.cwd).toBe('/tmp/retry')
    expect(rePayload.input).toEqual({ command: 'echo hi' })

    // Old executor's late ACK is ignored (its bind was removed).
    oldSock.emitted[0]!.ack!({
      callId: 'c1',
      ok: false,
      content: 'ghost result',
    })

    redispatched.ack!({ callId: 'c1', ok: true, content: 'redone' })
    await expect(p).resolves.toEqual({ ok: true, content: 'redone' })
  })

  it('supersede-then-disconnect only fails calls still pending on the new socket', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-5': 'ws-default' }),
      5_000,
      undefined,
      0, // no grace window — assert instant-detach semantics
    )
    const oldSock = makeFakeSocket('old-2')
    reg.attach(oldSock as never, announceOf('e-drop'))
    const p = reg.callTool('sess-5', callEffect('c1'))
    const newSock = makeFakeSocket('new-2')
    reg.attach(newSock as never, announceOf('e-drop'))
    reg.detach(newSock as never)
    await expect(p).resolves.toEqual({
      ok: false,
      content: 'executor disconnected',
    })
  })

  it('detach on a stale socket is a no-op (does not disturb the current bind)', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-6': 'ws-default' }),
      5_000,
    )
    const oldSock = makeFakeSocket('stale-old')
    reg.attach(oldSock as never, announceOf('e-stale'))
    const p = reg.callTool('sess-6', callEffect('c1'))
    const newSock = makeFakeSocket('stale-new')
    reg.attach(newSock as never, announceOf('e-stale'))

    reg.detach(oldSock as never)

    const redispatched = newSock.emitted[newSock.emitted.length - 1]!
    redispatched.ack!({ callId: 'c1', ok: true, content: 'ok' })
    await expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('detach grace window: a fresh executorId that reclaims the same workspaceId resurrects pending calls and emits "updated" (no detach flicker)', async () => {
    const changes: ServerExecutorChangedPayload[] = []
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-grace': 'ws-restart' }),
      5_000,
      undefined,
      500, // 500ms grace window
    )
    reg.onChange((c) => changes.push(c))

    const oldSock = makeFakeSocket('grace-old')
    reg.attach(oldSock as never, announceOf('e-old', 'ws-restart'))
    const p = reg.callTool('sess-grace', callEffect('c1'))
    expect(oldSock.emitted).toHaveLength(1)

    // Executor process dies. Grace timer starts; no detach event yet.
    reg.detach(oldSock as never)
    expect(changes.find((c) => c.change === 'detached')).toBeUndefined()

    // Process restarts with a fresh executorId but same workspaceId.
    const newSock = makeFakeSocket('grace-new')
    reg.attach(newSock as never, announceOf('e-new', 'ws-restart'))

    // Pending call transferred and re-emitted to the new socket.
    expect(newSock.emitted).toHaveLength(1)
    const redispatched = newSock.emitted[0]!
    expect((redispatched.payload as ToolCallMessage).callId).toBe('c1')

    // Wire event is 'updated', not 'attached' — the dashboard sees a
    // seamless swap instead of a flicker.
    const lastChange = changes[changes.length - 1]
    expect(lastChange?.change).toBe('updated')

    redispatched.ack!({ callId: 'c1', ok: true, content: 'survived' })
    await expect(p).resolves.toEqual({ ok: true, content: 'survived' })

    // The detach event never fires after grace resolution.
    await new Promise((r) => setTimeout(r, 600))
    expect(changes.find((c) => c.change === 'detached')).toBeUndefined()
  })

  it('detach grace window: if nobody reconnects, pending calls fail and detached fans out when the timer fires', async () => {
    const changes: ServerExecutorChangedPayload[] = []
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-grace-expire': 'ws-lonely' }),
      5_000,
      undefined,
      50, // very short grace
    )
    reg.onChange((c) => changes.push(c))

    const sock = makeFakeSocket('lonely')
    reg.attach(sock as never, announceOf('e-lonely', 'ws-lonely'))
    const p = reg.callTool('sess-grace-expire', callEffect('c1'))
    reg.detach(sock as never)

    await expect(p).resolves.toEqual({
      ok: false,
      content: 'executor disconnected',
    })
    expect(changes.at(-1)?.change).toBe('detached')
  })

  it('honours the tool-call timeout when nobody ever acks', async () => {
    vi.useFakeTimers()
    try {
      const reg = createExecutorRegistry(
        fakeIo() as never,
        makeResolver({ 'sess-7': 'ws-default' }),
        100,
      )
      const sock = makeFakeSocket('to')
      reg.attach(sock as never, announceOf('e-to'))
      const p = reg.callTool('sess-7', callEffect('c1'))
      await vi.advanceTimersByTimeAsync(150)
      await expect(p).resolves.toMatchObject({
        ok: false,
        content: 'tool call ack timed out after 100ms',
        failure: { code: 'tool_ack_timeout', outcome: 'indeterminate', timeoutStage: 'acknowledgement' },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the original timeout deadline across reconnects', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const reg = createExecutorRegistry(
        fakeIo() as never,
        makeResolver({ 'sess-deadline': 'ws-default' }),
        100,
      )
      const first = makeFakeSocket('deadline-1')
      reg.attach(first as never, announceOf('e-deadline'))
      const pending = reg.callTool('sess-deadline', callEffect('c-deadline'))

      await vi.advanceTimersByTimeAsync(80)
      const replacement = makeFakeSocket('deadline-2')
      reg.attach(replacement as never, announceOf('e-deadline'))

      // Reconnect leaves only the original 20ms budget; it must not reset to a
      // new 100ms window.
      await vi.advanceTimersByTimeAsync(19)
      let settled = false
      void pending.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toEqual({
        ok: false,
        content: 'tool call ack timed out after 100ms (post-reconnect)',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelPending emits tool:cancel for every in-flight call in that session', () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-8': 'ws-default' }),
      5_000,
    )
    const sock = makeFakeSocket('cx')
    reg.attach(sock as never, announceOf('e-cx'))
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

  it('cancels pending calls during detach grace and does not redispatch them', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-grace-cancel': 'ws-default' }),
      5_000,
      undefined,
      10_000,
    )
    const oldSock = makeFakeSocket('grace-cancel-old')
    reg.attach(oldSock as never, announceOf('e-grace-cancel'))
    const pending = reg.callTool('sess-grace-cancel', callEffect('c1'))

    reg.detach(oldSock as never)
    expect(reg.activeSessions()).toEqual(['sess-grace-cancel'])
    reg.cancelPending('sess-grace-cancel')
    await expect(pending).resolves.toEqual({ ok: false, content: 'cancelled by user' })
    expect(reg.activeSessions()).toEqual([])

    const newSock = makeFakeSocket('grace-cancel-new')
    reg.attach(newSock as never, announceOf('e-grace-cancel'))
    expect(newSock.emitted.filter((entry) => entry.event === 'tool:call')).toHaveLength(0)
  })

  it('routes two different sessions to the same executor (1:N)', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-A': 'ws-default', 'sess-B': 'ws-default' }),
      5_000,
    )
    const sock = makeFakeSocket('daemon')
    reg.attach(sock as never, announceOf('e-shared'))

    const pA = reg.callTool('sess-A', callEffect('a1'))
    const pB = reg.callTool('sess-B', callEffect('b1'))
    expect(sock.emitted).toHaveLength(2)
    expect((sock.emitted[0]!.payload as ToolCallMessage).sessionId).toBe('sess-A')
    expect((sock.emitted[1]!.payload as ToolCallMessage).sessionId).toBe('sess-B')

    sock.emitted[0]!.ack!({ callId: 'a1', ok: true, content: 'A' })
    sock.emitted[1]!.ack!({ callId: 'b1', ok: true, content: 'B' })
    await expect(pA).resolves.toEqual({ ok: true, content: 'A' })
    await expect(pB).resolves.toEqual({ ok: true, content: 'B' })
  })

  it('cancelPending only cancels calls for the target session, not siblings sharing the executor', () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({
        'sess-keep': 'ws-default',
        'sess-cancel': 'ws-default',
      }),
      5_000,
    )
    const sock = makeFakeSocket('shared')
    reg.attach(sock as never, announceOf('e-shared-cancel'))

    void reg.callTool('sess-keep', callEffect('k1'))
    void reg.callTool('sess-cancel', callEffect('c1'))
    void reg.callTool('sess-cancel', callEffect('c2'))

    reg.cancelPending('sess-cancel')

    const cancels = sock.emitted.filter((e) => e.event === 'tool:cancel')
    expect(cancels).toHaveLength(2)
    for (const c of cancels) {
      expect((c.payload as { sessionId: string }).sessionId).toBe('sess-cancel')
    }
  })

  it('reports no-executor when a session tries to call before any daemon attaches', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-orphan': 'ws-default' }),
      5_000,
    )
    const p = reg.callTool('sess-orphan', callEffect('c1'))
    await expect(p).resolves.toMatchObject({
      ok: false,
      content: 'workspace ws-default is offline — start its executor to run tools',
      failure: { code: 'workspace_offline', outcome: 'blocked' },
    })
  })

  it('routes a call to the executor announcing the matching workspaceId', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-mbp': 'ws-mbp', 'sess-linux': 'ws-linux' }),
      5_000,
    )
    const mbp = makeFakeSocket('mbp')
    const linux = makeFakeSocket('linux')
    reg.attach(mbp as never, announceOf('e-mbp', 'ws-mbp', 'mbp'))
    reg.attach(linux as never, announceOf('e-linux', 'ws-linux', 'linux-box'))

    const p1 = reg.callTool('sess-mbp', callEffect('c1'))
    const p2 = reg.callTool('sess-linux', callEffect('c2'))
    expect(mbp.emitted).toHaveLength(1)
    expect(linux.emitted).toHaveLength(1)
    expect((mbp.emitted[0]!.payload as ToolCallMessage).sessionId).toBe('sess-mbp')
    expect((linux.emitted[0]!.payload as ToolCallMessage).sessionId).toBe('sess-linux')

    mbp.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'mbp' })
    linux.emitted[0]!.ack!({ callId: 'c2', ok: true, content: 'linux' })
    await expect(p1).resolves.toEqual({ ok: true, content: 'mbp' })
    await expect(p2).resolves.toEqual({ ok: true, content: 'linux' })
  })

  it('reports workspace-offline when the bound workspace has no executor attached', async () => {
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-lonely': 'ws-missing' }),
      5_000,
    )
    // Attach a different workspace — the target one is still offline.
    reg.attach(
      makeFakeSocket('other') as never,
      announceOf('e-other', 'ws-other', 'other'),
    )
    const p = reg.callTool('sess-lonely', callEffect('c1'))
    await expect(p).resolves.toMatchObject({
      ok: false,
      content: 'workspace ws-missing is offline — start its executor to run tools',
      failure: { code: 'workspace_offline', outcome: 'blocked' },
    })
  })

  it('legacy sessions with no workspaceId fall back to any online executor', async () => {
    // Sessions predating the workspaceId field must keep working — the
    // resolver returns undefined for them and the registry picks whichever
    // executor is online.
    const reg = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-legacy': undefined }),
      5_000,
    )
    const sock = makeFakeSocket('only')
    reg.attach(sock as never, announceOf('e-only', 'ws-only', 'only'))
    const p = reg.callTool('sess-legacy', callEffect('c1'))
    expect(sock.emitted).toHaveLength(1)
    sock.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'ok' })
    await expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('rejects a second executor claiming the same workspaceId while the first is still connected', () => {
    const reg = createExecutorRegistry(fakeIo() as never, makeResolver(), 5_000)
    const first = makeFakeSocket('first')
    reg.attach(first as never, announceOf('e-first', 'ws-shared'))

    const second = makeFakeSocket('second')
    reg.attach(second as never, announceOf('e-second', 'ws-shared'))

    // Second attempt must be told off + disconnected. First must remain
    // the sole claimant.
    expect(second.connected).toBe(false)
    const reject = second.emitted.find((e) => e.event === 'executor:host_reject')
    expect(reject).toBeDefined()
    expect((reject!.payload as { code: string }).code).toBe('workspace_id_conflict')

    // First should still be able to route tool calls.
    const p = reg.callTool('sess-x', callEffect('c1'))
    expect(first.emitted).toHaveLength(1) // tool:call went to the original
    first.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'ok' })
    return expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })

  it('lets a new executor claim a workspaceId whose previous holder has disconnected', () => {
    const reg = createExecutorRegistry(fakeIo() as never, makeResolver(), 5_000)
    const first = makeFakeSocket('first')
    reg.attach(first as never, announceOf('e-first', 'ws-takeover'))

    // Simulate the first executor's socket having gone down without a
    // detach event yet (race window). Its connected flag is false but the
    // bind still lives in the registry.
    first.connected = false

    const second = makeFakeSocket('second')
    reg.attach(second as never, announceOf('e-second', 'ws-takeover'))

    // Second executor is the new claimant; must not have been disconnected.
    expect(second.connected).toBe(true)
    expect(second.emitted.some((e) => e.event === 'executor:host_reject')).toBe(false)

    // Tool call should route to the new bind. Give the resolver a hint
    // that sess-y is bound to ws-takeover.
    const reg2 = createExecutorRegistry(
      fakeIo() as never,
      makeResolver({ 'sess-y': 'ws-takeover' }),
      5_000,
    )
    const a = makeFakeSocket('a')
    reg2.attach(a as never, announceOf('e-a', 'ws-takeover'))
    a.connected = false
    const b = makeFakeSocket('b')
    reg2.attach(b as never, announceOf('e-b', 'ws-takeover'))

    const p = reg2.callTool('sess-y', callEffect('c1'))
    // Only the new socket b should have received the tool:call
    expect(a.emitted).toHaveLength(0)
    expect(b.emitted).toHaveLength(1)
    b.emitted[0]!.ack!({ callId: 'c1', ok: true, content: 'ok' })
    return expect(p).resolves.toEqual({ ok: true, content: 'ok' })
  })
})
