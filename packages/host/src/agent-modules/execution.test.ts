import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createConfig, type CallToolEffect } from '@agent-kernel/kernel'

import { dispatchConfiguredTool } from './execution.js'
import { AskUserChoiceBroker } from '../ask-user-choice.js'
import { discoverSkills } from '../extensions/skills.js'
import type { HostLoopDeps, ToolDispatcher } from '../loop-types.js'
import type { LLMAdapter } from '../llm/adapter.js'
import { SessionStore } from '../store/session.js'

function effect(name: string, input: Record<string, unknown> = {}): CallToolEffect {
  return { kind: 'call_tool', callId: `${name}-1`, name, input }
}

function deps(store: SessionStore, tools: ToolDispatcher): HostLoopDeps {
  const llm: LLMAdapter = {
    name: 'unused',
    async call() {
      throw new Error('unused')
    },
  }
  return {
    store,
    llm,
    tools,
    broadcast: {
      onEvent() {},
      onApprovalRequired() {},
      onError() {},
    },
  }
}

describe('configured tool execution', () => {
  let dir: string
  let store: SessionStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-kernel-tool-exec-'))
    store = new SessionStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('dispatches executor tools to the executor registry', async () => {
    const record = await store.create({
      sessionId: 'sess-executor',
      config: createConfig({
        tools: [{
          name: 'read',
          description: 'read',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'executor',
          executionHandler: 'read',
        }],
      }),
    })
    const calls: string[] = []
    const result = await dispatchConfiguredTool(deps(store, {
      async callTool(_sessionId, eff) {
        calls.push(eff.name)
        return { ok: true, content: 'executor result' }
      },
      cancelPending() {},
    }), record.sessionId, effect('read'), new Map())

    expect(calls).toEqual(['read'])
    expect(result).toEqual({ ok: true, content: 'executor result' })
  })

  it('maps a model-facing executor tool name to its wire handler', async () => {
    const record = await store.create({ sessionId: 'sess-alias', config: createConfig({ tools: [{ name: 'shell', description: 'shell', inputSchema: { type: 'object' }, requiresApproval: false, executionKind: 'executor', executionHandler: 'bash' }] }) })
    let dispatched = ''
    await dispatchConfiguredTool(deps(store, { async callTool(_sessionId, eff) { dispatched = eff.name; return { ok: true, content: 'ok' } }, cancelPending() {} }), record.sessionId, effect('shell'), new Map())
    expect(dispatched).toBe('bash')
  })

  it('uses the reconnect-aware dispatcher only for planned continuation', async () => {
    const record = await store.create({ sessionId: 'sess-continuation', config: createConfig({ tools: [{ name: 'shell', description: 'shell', inputSchema: { type: 'object' }, requiresApproval: false, executionKind: 'executor', executionHandler: 'bash' }] }) })
    let ordinary = 0
    let continuation = 0
    const tools: ToolDispatcher = {
      async callTool() { ordinary += 1; return { ok: false, content: 'offline' } },
      async callToolWhenAvailable(_sessionId, dispatched) { continuation += 1; return { ok: true, content: dispatched.name } },
      cancelPending() {},
    }

    await expect(dispatchConfiguredTool(deps(store, tools), record.sessionId, effect('shell'), new Map())).resolves.toEqual({ ok: false, content: 'offline' })
    await expect(dispatchConfiguredTool(deps(store, tools), record.sessionId, effect('shell'), new Map(), undefined, undefined, true)).resolves.toEqual({ ok: true, content: 'bash' })
    expect({ ordinary, continuation }).toEqual({ ordinary: 1, continuation: 1 })
  })

  it('forces historical executor websearch schemas through the Host handler', async () => {
    const record = await store.create({
      sessionId: 'sess-legacy-websearch',
      config: createConfig({
        tools: [{
          name: 'websearch',
          description: 'websearch',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'executor',
          executionHandler: 'websearch',
        }],
      }),
    })
    let executorCalls = 0
    const result = await dispatchConfiguredTool({
      ...deps(store, {
        async callTool() {
          executorCalls += 1
          return { ok: false, content: 'wrong route' }
        },
        cancelPending() {},
      }),
      webSearchCredentials: { get: () => undefined },
    }, record.sessionId, effect('websearch', { query: 'query' }), new Map())

    expect(executorCalls).toBe(0)
    expect(result).toMatchObject({ ok: false, failure: { code: 'ESEARCH_CREDENTIAL' } })
  })

  it('runs ask_user_choice as a host-side user choice tool', async () => {
    const record = await store.create({
      sessionId: 'sess-ask-choice',
      config: createConfig({
        tools: [{
          name: 'ask_user_choice',
          description: 'ask',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'ask_user_choice',
        }],
      }),
    })
    const broker = new AskUserChoiceBroker()
    const call = effect('ask_user_choice', {
      message: 'Pick a mode',
      choices: [{ value: 'fast', label: 'Fast' }, { value: 'safe', label: 'Safe' }],
    })
    const pending = dispatchConfiguredTool({
      ...deps(store, {
        async callTool() {
          return { ok: false, content: 'wrong route' }
        },
        cancelPending() {},
      }),
      askUserChoice: broker,
    }, record.sessionId, call, new Map())

    expect(broker.respond(record.sessionId, call.callId, 'safe')).toEqual({ ok: true })
    await expect(pending).resolves.toEqual({ ok: true, content: JSON.stringify({ value: 'safe', label: 'Safe' }) })
  })

  it('runs the skill host handler without calling the executor', async () => {
    const skillsRoot = join(dir, 'skills-root')
    const skillDir = join(skillsRoot, 'demo-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), ['---', 'name: demo-skill', 'description: Demo skill.', '---', '', 'BODY'].join('\n'))
    const skills = await discoverSkills([skillsRoot])
    const record = await store.create({
      sessionId: 'sess-skill',
      config: createConfig({
        tools: [{
          name: 'skill',
          description: 'skill',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'skill',
        }],
      }),
    })
    let executorCalls = 0
    const result = await dispatchConfiguredTool({
      ...deps(store, {
        async callTool() {
          executorCalls += 1
          return { ok: false, content: 'wrong route' }
        },
        cancelPending() {},
      }),
      skills,
    }, record.sessionId, effect('skill', { name: 'demo-skill' }), new Map())

    expect(executorCalls).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('BODY')
  })

  it('fails closed for unknown host handlers', async () => {
    const record = await store.create({
      sessionId: 'sess-unknown-host',
      config: createConfig({
        tools: [{
          name: 'custom',
          description: 'custom',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'missing-handler',
        }],
      }),
    })

    await expect(dispatchConfiguredTool(deps(store, {
      async callTool() {
        return { ok: true, content: 'wrong route' }
      },
      cancelPending() {},
    }), record.sessionId, effect('custom'), new Map())).resolves.toEqual({
      ok: false,
      content: 'host tool handler is not registered: missing-handler',
    })
  })
})
