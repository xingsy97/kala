import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConfig, type CallToolEffect } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LLMAdapter } from '../llm/adapter.js'
import type { HostLoopDeps, LoopHandle, ToolDispatcher } from '../loop-types.js'
import { SessionStore } from '../store/session.js'
import { createRuntimeToolDispatcher } from './tool-dispatcher.js'

function effect(name: string, input: Record<string, unknown>): CallToolEffect {
  return { kind: 'call_tool', callId: `${name}-call`, name, input }
}

describe('runtime tool dispatcher', () => {
  let dir: string
  let store: SessionStore
  let executorCall: ReturnType<typeof vi.fn>
  let executors: ToolDispatcher
  let deps: HostLoopDeps

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-tool-dispatcher-'))
    store = new SessionStore(dir)
    executorCall = vi.fn(async () => ({ ok: true, content: 'executor result' }))
    executors = {
      callTool: executorCall,
      cancelPending: vi.fn(),
    }
    const llm: LLMAdapter = {
      name: 'unused',
      async call() {
        throw new Error('unused')
      },
    }
    deps = {
      store,
      llm,
      tools: executors,
      broadcast: {
        onEvent() {},
        onApprovalRequired() {},
        onError() {},
      },
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('routes executor-scoped tools to the executor registry', async () => {
    await store.create({
      sessionId: 'executor-session',
      config: createConfig({
        tools: [{
          name: 'shell',
          description: 'Run a shell command',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'executor',
          executionHandler: 'shell',
        }],
      }),
    })
    const dispatcher = createRuntimeToolDispatcher(deps, executors, {} as LoopHandle)

    await expect(dispatcher.callTool(
      'executor-session',
      effect('shell', { command: 'pwd' }),
    )).resolves.toEqual({ ok: true, content: 'executor result' })
    expect(executorCall).toHaveBeenCalledOnce()
  })

  it('routes host-scoped tools through the Host without calling an executor', async () => {
    await store.create({
      sessionId: 'host-session',
      config: createConfig({
        tools: [{
          name: 'todo_graph',
          description: 'Update the task graph',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'todo_graph',
        }],
      }),
    })
    const dispatcher = createRuntimeToolDispatcher(deps, executors, {} as LoopHandle)

    const result = await dispatcher.callTool(
      'host-session',
      effect('todo_graph', {
        operations: [{
          op: 'replace',
          nodes: [{ id: 'runtime-check', content: 'Runtime tool routing', status: 'completed' }],
          edges: [],
        }],
      }),
    )

    expect(result.ok).toBe(true)
    expect(executorCall).not.toHaveBeenCalled()
    expect(JSON.parse(result.content).nodes).toEqual([
      expect.objectContaining({ id: 'runtime-check', status: 'completed' }),
    ])
  })

  it('creates and runs Copilot sub-agents through the parent Runtime', async () => {
    await store.create({
      sessionId: 'copilot-parent',
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      externalSessionId: 'copilot-parent',
      config: createConfig({
        tools: [{
          name: 'agent',
          description: 'Spawn a sub-agent',
          inputSchema: { type: 'object' },
          requiresApproval: false,
          executionKind: 'host',
          executionHandler: 'agent',
        }],
      }),
    })
    const send = vi.fn(async (record) => {
      await store.recordRuntimeProjection(
        record.sessionId,
        {
          ...record.state,
          cursor: record.state.cursor + 1,
          status: 'done',
          messages: [
            ...record.state.messages,
            { role: 'assistant', content: [{ type: 'text', text: 'copilot child result' }] },
          ],
        },
        'copilot.assistant_message',
        {},
      )
    })
    const dispatcher = createRuntimeToolDispatcher(deps, executors, {} as LoopHandle, {
      send,
      cancel: vi.fn(),
    })

    const result = await dispatcher.callTool(
      'copilot-parent',
      effect('agent', { prompt: 'delegate through Copilot' }),
    )

    if (!result.ok) throw new Error(result.content)
    expect(result.ok).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    const child = store.list().find((record) => record.parentSessionId === 'copilot-parent')
    expect(child).toMatchObject({
      agentRuntime: 'copilot',
      agentRuntimeVersion: '1.0.11',
      externalSessionId: child?.sessionId,
    })
    expect(result.content).toContain('copilot child result')
  })
})
