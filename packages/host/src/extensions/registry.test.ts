import { describe, expect, it, vi } from 'vitest'

import type { AgentConfig, CallLlmEffect, CallToolEffect, Message } from '@agent-kernel/kernel'

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

  it('registers session modes and rejects duplicate capability ownership', () => {
    const compact = vi.fn(async () => true)
    const consolidateMemory = vi.fn(async () => ({ saved: [], skipped: 0 }))
    const registry = createExtensionRegistry([{
      id: 'one',
      version: '1',
      sessionModes: [{ id: 'chat', label: 'Chat', description: 'Chat mode' }],
      maintenance: { compact, consolidateMemory },
    }])
    expect(registry.listSessionModes()).toEqual([{ id: 'chat', label: 'Chat', description: 'Chat mode' }])
    expect(registry.getSessionMode('chat')?.label).toBe('Chat')
    expect(() => registry.register({
      id: 'two',
      version: '1',
      sessionModes: [{ id: 'chat', label: 'Other', description: 'Duplicate' }],
    })).toThrow('duplicate session mode')
    expect(() => registry.register({
      id: 'three',
      version: '1',
      maintenance: { compact },
    })).toThrow('duplicate compaction contribution')
    expect(() => registry.register({
      id: 'four',
      version: '1',
      maintenance: { consolidateMemory },
    })).toThrow('duplicate memory consolidation contribution')
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

  it('runs session, turn, model, cancellation, and recovery lifecycles in registration order', async () => {
      const calls: string[] = []
      const registry = createExtensionRegistry([
        {
          id: 'one',
          version: '1',
          lifecycle: {
            onSessionCreated: () => { calls.push('created-one') },
            onSessionLoaded: () => { calls.push('loaded-one') },
            onSessionDeleted: () => { calls.push('deleted-one') },
            beforeStateTransition: () => { calls.push('before-transition-one') },
            beforeTurn: () => { calls.push('before-turn-one') },
            afterTurn: () => { calls.push('after-turn-one') },
            beforeModelCall: (input) => {
              calls.push('before-model-one')
              return [...input.messages, { role: 'user', content: [{ type: 'text', text: 'one' }] }]
            },
            afterModelCall: () => { calls.push('after-model-one') },
            onCancel: () => { calls.push('cancel-one') },
            recoverSession: () => { calls.push('recover-one'); return false },
          },
        },
        {
          id: 'two',
          version: '1',
          lifecycle: {
            beforeModelCall: (input) => {
              calls.push(`before-model-two:${input.messages.length}`)
            },
            recoverSession: () => { calls.push('recover-two'); return true },
          },
        },
      ])
      const deps = {} as HostToolContext['deps']
      const record = { sessionId: 'session' } as never
      const loop = {} as never
      const event = { kind: 'clear' } as const
      const sessionContext = { deps, record }
      const turnContext = {
        deps,
        sessionId: 'session',
        event,
        loop,
        autoCompact: vi.fn(async () => {}),
        resumeDurableWork: vi.fn(async () => {}),
      }
      const messages: readonly Message[] = [{ role: 'user', content: [{ type: 'text', text: 'start' }] }]
      const modelContext = {
        deps,
        sessionId: 'session',
        config: { tools: [] } as unknown as AgentConfig,
        effect: { kind: 'call_llm', messages, tools: [] } as CallLlmEffect,
        messages,
        requiresCompaction: false,
        compact: vi.fn(async () => false),
        messagesAfterCompaction: () => messages,
      }

      await registry.sessionCreated(sessionContext)
      await registry.sessionLoaded(sessionContext)
      await registry.sessionDeleted(sessionContext)
      await registry.beforeStateTransition({ deps, record, event })
      await registry.beforeTurn(turnContext)
      await registry.afterTurn(turnContext)
      await expect(registry.beforeModelCall(modelContext)).resolves.toHaveLength(2)
      await registry.afterModelCall(modelContext, {} as never)
      await registry.cancel({ deps, sessionId: 'session', aborts: new Map() })
      await expect(registry.recoverSession({ deps, sessionId: 'session', loop })).resolves.toBe(true)

      expect(calls).toEqual([
        'created-one',
        'loaded-one',
        'deleted-one',
        'before-transition-one',
        'before-turn-one',
        'after-turn-one',
        'before-model-one',
        'before-model-two:2',
        'after-model-one',
        'cancel-one',
        'recover-one',
        'recover-two',
      ])
  })

  it('dispatches maintenance through the registered owner', async () => {
      const compact = vi.fn(async () => true)
      const consolidateMemory = vi.fn(async () => ({ saved: ['preference'], skipped: 0 }))
      const registry = createExtensionRegistry([{
        id: 'maintenance',
        version: '1',
        maintenance: { compact, consolidateMemory },
      }])
      const deps = {} as HostToolContext['deps']
      await expect(registry.compact(
        deps,
        'session',
        { trigger: 'manual', continuation: 'stay_resting' },
        new Set(),
        new Map(),
      )).resolves.toBe(true)
      await expect(registry.consolidateMemory(deps, 'session')).resolves.toEqual({
        saved: ['preference'],
        skipped: 0,
      })
      expect(compact).toHaveBeenCalledOnce()
      expect(consolidateMemory).toHaveBeenCalledOnce()
  })
})
