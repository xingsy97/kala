import { describe, expect, it, vi } from 'vitest'

import { OperationDeduper, type OperationScope } from './operation-deduper.js'

const scope: OperationScope = {
  principal: 'github:42',
  sessionId: 'session-a',
  eventKind: 'client:user_message',
}

describe('OperationDeduper', () => {
  it('executes a duplicate operation id once and replays the ACK', async () => {
    const deduper = new OperationDeduper()
    const operation = vi.fn(async () => 'applied')
    const payload = { text: 'hello', mode: 'queue' }

    const first = await deduper.run('op-1', scope, payload, operation)
    const duplicate = await deduper.run('op-1', scope, payload, operation)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ ok: true, value: 'applied' })
    expect(duplicate).toEqual(first)
  })

  it('coalesces concurrent duplicates', async () => {
    const deduper = new OperationDeduper()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const operation = vi.fn(async () => { await gate })

    const first = deduper.run('op-2', scope, { text: 'same' }, operation)
    const duplicate = deduper.run('op-2', scope, { text: 'same' }, operation)
    release()

    expect(await first).toEqual({ ok: true })
    expect(await duplicate).toEqual({ ok: true })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('does not collide when sessions use the same operation id', async () => {
    const deduper = new OperationDeduper()
    const first = vi.fn(async () => 'first-session')
    const second = vi.fn(async () => 'second-session')

    await expect(deduper.run('shared-id', scope, { text: 'same' }, first)).resolves.toEqual({ ok: true, value: 'first-session' })
    await expect(deduper.run('shared-id', { ...scope, sessionId: 'session-b' }, { text: 'same' }, second)).resolves.toEqual({ ok: true, value: 'second-session' })

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('scopes operation ids by principal and event kind', async () => {
    const deduper = new OperationDeduper()
    const operation = vi.fn(async () => undefined)

    await deduper.run('shared-id', scope, { value: 1 }, operation)
    await deduper.run('shared-id', { ...scope, principal: 'github:84' }, { value: 1 }, operation)
    await deduper.run('shared-id', { ...scope, eventKind: 'client:cancel' }, { value: 1 }, operation)

    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('rejects a scoped operation id reused with a different payload', async () => {
    const deduper = new OperationDeduper()
    const operation = vi.fn(async () => 'applied')

    await expect(deduper.run('op-conflict', scope, { text: 'first', nested: { b: 2, a: 1 } }, operation)).resolves.toEqual({ ok: true, value: 'applied' })
    await expect(deduper.run('op-conflict', scope, { nested: { a: 1, b: 2 }, text: 'changed' }, operation)).resolves.toEqual({
      ok: false,
      error: 'operationId was already used with a different payload',
    })
    expect(operation).toHaveBeenCalledOnce()
  })
})
