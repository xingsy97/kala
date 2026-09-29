import { describe, expect, it, vi } from 'vitest'

import type { CallToolEffect } from '@agent-kernel/kernel'

import { createExtensionRegistry, type HostToolContext } from './registry.js'

function context(): HostToolContext {
  return {
    deps: {} as HostToolContext['deps'],
    sessionId: 'session',
    effect: { kind: 'call_tool', callId: 'call', name: 'example', input: {} } as CallToolEffect,
    aborts: new Map(),
    plannedContinuation: false,
  }
}

describe('ExtensionRegistry', () => {
  it('registers, dispatches, lists, and seals extensions', async () => {
    const registry = createExtensionRegistry()
    registry.register({
      id: 'example',
      version: '1',
      toolHandlers: { example: async () => ({ ok: true, content: 'done' }) },
    })
    expect(registry.list().map((extension) => extension.id)).toEqual(['example'])
    await expect(registry.dispatchHostTool('example', context())).resolves.toEqual({ ok: true, content: 'done' })
    registry.seal()
    expect(() => registry.register({ id: 'late', version: '1' })).toThrow('extension registry is sealed')
  })

  it('rejects duplicate extension and handler ownership', () => {
    const registry = createExtensionRegistry([{ id: 'one', version: '1', toolHandlers: { shared: async () => ({ ok: true, content: '' }) } }])
    expect(() => registry.register({ id: 'one', version: '2' })).toThrow('duplicate extension id')
    expect(() => registry.register({ id: 'two', version: '1', toolHandlers: { shared: async () => ({ ok: true, content: '' }) } })).toThrow('duplicate host tool handler')
  })

  it('runs lifecycle callbacks in registration order and stops on a blocker', async () => {
    const calls: string[] = []
    const after = vi.fn()
    const registry = createExtensionRegistry([
      { id: 'one', version: '1', lifecycle: { beforeToolDispatch: () => { calls.push('one'); return null }, afterToolDispatch: () => { calls.push('after-one') } } },
      { id: 'two', version: '1', lifecycle: { beforeToolDispatch: () => { calls.push('two'); return { ok: false, content: 'blocked' } }, afterToolDispatch: after } },
      { id: 'three', version: '1', lifecycle: { beforeToolDispatch: () => { calls.push('three'); return null } } },
    ])
    await expect(registry.beforeToolDispatch(context())).resolves.toEqual({ ok: false, content: 'blocked' })
    expect(calls).toEqual(['one', 'two'])
    await registry.afterToolDispatch(context(), { ok: true, content: 'done' })
    expect(calls).toEqual(['one', 'two', 'after-one'])
    expect(after).toHaveBeenCalledOnce()
  })

  it('returns the stable unknown-handler failure', async () => {
    const registry = createExtensionRegistry()
    await expect(registry.dispatchHostTool('missing', context())).resolves.toEqual({
      ok: false,
      content: 'host tool handler is not registered: missing',
    })
  })
})
