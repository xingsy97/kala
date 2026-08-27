import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConfig } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolDispatcher } from '../loop-types.js'
import { SessionStore } from '../store/session.js'
import { CopilotAgentRuntime } from './copilot-runtime.js'

type CapturedTool = {
  name: string
  handler(
    args: unknown,
    invocation: { toolCallId: string },
  ): Promise<{ textResultForLlm: string; resultType: string; error?: string }>
}

const sdk = vi.hoisted(() => ({
  configs: [] as Array<{ tools: CapturedTool[] }>,
}))

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    async start() {}
    async stop() {}
    async getAuthStatus() {
      return { isAuthenticated: true }
    }
    async resumeSession() {
      throw new Error('not found')
    }
    async createSession(config: { tools: CapturedTool[] }) {
      sdk.configs.push(config)
      return {
        async send() {},
        on() {},
        async abort() {},
        async disconnect() {},
      }
    }
    async deleteSession() {}
  },
}))

describe('Copilot runtime custom tools', () => {
  let dir: string
  let store: SessionStore

  beforeEach(() => {
    sdk.configs.length = 0
    dir = mkdtempSync(join(tmpdir(), 'copilot-runtime-tools-'))
    store = new SessionStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('delegates an SDK custom tool call to the configured runtime dispatcher', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'host tool result' }))
    const tools: ToolDispatcher = {
      callTool,
      cancelPending() {},
    }
    const runtime = new CopilotAgentRuntime({
      store,
      tools,
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, {
      enabled: true,
      sessionsDir: dir,
    })
    const record = await store.create({
      sessionId: 'copilot-tool-session',
      agentRuntime: 'copilot',
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

    await runtime.start()
    await runtime.send(record, { text: 'Use todo_graph.' })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'todo_graph')
    expect(tool).toBeDefined()

    const result = await tool?.handler(
      { operations: [{ op: 'clear' }] },
      { toolCallId: 'copilot-call-1' },
    )

    expect(callTool).toHaveBeenCalledWith('copilot-tool-session', {
      kind: 'call_tool',
      callId: 'copilot-call-1',
      name: 'todo_graph',
      input: { operations: [{ op: 'clear' }] },
    })
    expect(result).toEqual({
      textResultForLlm: 'host tool result',
      resultType: 'success',
    })
    const state = store.get(record.sessionId)?.state
    expect(state?.messages.flatMap((message) => message.content)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_call',
        callId: 'copilot-call-1',
        name: 'todo_graph',
      }),
      expect.objectContaining({
        type: 'tool_result',
        callId: 'copilot-call-1',
        ok: true,
        content: 'host tool result',
      }),
    ]))
    await runtime.close()
  })

  it('settles an unresumable approval instead of reporting an expired runtime error', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: {
        async callTool() {
          return { ok: true, content: 'unused' }
        },
        cancelPending() {},
      },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, {
      enabled: false,
      sessionsDir: dir,
    })
    const record = await store.create({
      sessionId: 'copilot-expired-approval',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await store.recordRuntimeProjection(record.sessionId, {
      ...record.state,
      cursor: record.state.cursor + 1,
      status: 'awaiting_approval',
      pendingCalls: [{
        callId: 'call-expired',
        name: 'shell',
        input: { command: 'true' },
        status: 'awaiting_approval',
      }],
      messages: [...record.state.messages, {
        role: 'assistant',
        content: [{
          type: 'tool_call',
          callId: 'call-expired',
          name: 'shell',
          input: { command: 'true' },
        }],
      }],
    }, 'copilot.tool_call', { callId: 'call-expired' })

    await expect(runtime.approve(record, 'call-expired')).resolves.toBeUndefined()
    await expect(runtime.approve(record, 'call-expired')).resolves.toBeUndefined()

    const state = store.get(record.sessionId)?.state
    expect(state?.status).toBe('error')
    expect(state?.pendingCalls).toEqual([])
    expect(state?.error).toBe('Copilot approval could not be resumed after host restart')
    expect(state?.messages.flatMap((message) => message.content)).toContainEqual({
      type: 'tool_result',
      callId: 'call-expired',
      ok: false,
      content: 'Copilot approval could not be resumed after host restart',
    })
  })
})
