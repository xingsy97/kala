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
  overridesBuiltInTool?: boolean
  handler(
    args: unknown,
    invocation: { toolCallId: string },
  ): Promise<{ textResultForLlm: string; resultType: string; error?: string }>
}

const sdk = vi.hoisted(() => ({
  clientOptions: [] as Array<{ connection?: { kind: string; args?: readonly string[] } }>,
  configs: [] as Array<{
    tools: CapturedTool[]
    workingDirectory?: string
    remoteSession?: string
    infiniteSessions?: {
      enabled?: boolean
      backgroundCompactionThreshold?: number
      bufferExhaustionThreshold?: number
    }
  }>,
  resumeConfigs: [] as Array<{
    tools: CapturedTool[]
    workingDirectory?: string
    remoteSession?: string
    infiniteSessions?: {
      enabled?: boolean
      backgroundCompactionThreshold?: number
      bufferExhaustionThreshold?: number
    }
  }>,
  resumeSucceeds: false,
  listeners: [] as Array<(event: unknown) => void>,
  historyEvents: [] as Array<unknown>,
  responses: [] as Array<unknown>,
  sentMessages: [] as Array<unknown>,
  currentModel: { modelId: 'gpt-5.4-mini', contextTier: 'long_context' },
  abort: vi.fn(async () => {}),
  setModel: vi.fn(async () => {}),
  compact: vi.fn(async () => ({
    success: true,
    tokensRemoved: 80_000,
    messagesRemoved: 40,
    contextWindow: {
      currentTokens: 40_000,
      tokenLimit: 128_000,
      messagesLength: 10,
      systemTokens: 1_000,
      conversationTokens: 35_000,
      toolDefinitionsTokens: 4_000,
    },
  })),
}))

vi.mock('@github/copilot-sdk', () => ({
  RuntimeConnection: {
    forStdio(options: { args?: readonly string[] } = {}) {
      return { kind: 'stdio', ...options }
    },
  },
  CopilotClient: class {
    constructor(options: { connection?: { kind: string; args?: readonly string[] } }) {
      sdk.clientOptions.push(options)
    }
    async start() {}
    async stop() {}
    async getAuthStatus() {
      return { isAuthenticated: true }
    }
    async listModels() {
      return [{
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 mini',
        capabilities: { limits: { max_context_window_tokens: 128_000 } },
      }]
    }
    async resumeSession(_sessionId: string, config: { tools: CapturedTool[]; workingDirectory?: string; remoteSession?: string }) {
      sdk.resumeConfigs.push(config)
      if (!sdk.resumeSucceeds) throw new Error('not found')
      return this.session()
    }
    async createSession(config: { tools: CapturedTool[]; workingDirectory?: string; remoteSession?: string }) {
      sdk.configs.push(config)
      return this.session()
    }
    session() {
      return {
        rpc: {
          history: { compact: sdk.compact },
          model: { async getCurrent() { return sdk.currentModel } },
        },
        async getEvents() {
          return sdk.historyEvents
        },
        async send() {},
        async sendAndWait(options: unknown) {
          sdk.sentMessages.push(options)
          if (sdk.responses.length > 0) {
            const response = sdk.responses.shift()
            if (response instanceof Error) throw response
            return response
          }
          return await new Promise(() => {})
        },
        on(listener: (event: unknown) => void) {
          sdk.listeners.push(listener)
          return () => {
            const index = sdk.listeners.indexOf(listener)
            if (index >= 0) sdk.listeners.splice(index, 1)
          }
        },
        abort: sdk.abort,
        setModel: sdk.setModel,
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
    sdk.clientOptions.length = 0
    sdk.resumeConfigs.length = 0
    sdk.resumeSucceeds = false
    sdk.listeners.length = 0
    sdk.historyEvents.length = 0
    sdk.responses.length = 0
    sdk.sentMessages.length = 0
    sdk.currentModel = { modelId: 'gpt-5.4-mini', contextTier: 'long_context' }
    sdk.abort.mockClear()
    sdk.setModel.mockClear()
    sdk.compact.mockClear()
    dir = mkdtempSync(join(tmpdir(), 'copilot-runtime-tools-'))
    store = new SessionStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists a model-change notice only after the SDK accepts the model', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
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
      sessionId: 'copilot-model-session',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await store.updatePreferences(record.sessionId, { selectedModel: 'gpt-old' })

    await runtime.start()
    await runtime.setModel(record, 'gpt-new')
    await runtime.confirmModelChange(record, 'gpt-old', 'gpt-new')

    expect(sdk.setModel).toHaveBeenCalledWith('gpt-new')
    expect(store.get(record.sessionId)?.state.messages.at(-1)).toMatchObject({
      role: 'system',
      metadata: { kind: 'model_changed', from: 'gpt-old', to: 'gpt-new' },
    })

    sdk.setModel.mockRejectedValueOnce(new Error('model unavailable'))
    await expect(runtime.setModel(record, 'gpt-broken')).rejects.toThrow('model unavailable')
    expect(store.get(record.sessionId)?.state.messages).toHaveLength(1)
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
      initialCwd: '/workspace/only-on-the-executor',
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
    await runtime.send(record, { text: 'Use todo_graph.', model: 'gpt-5.4-mini' })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'todo_graph')
    expect(tool).toBeDefined()
    expect(tool?.overridesBuiltInTool).toBe(true)
    expect(sdk.clientOptions).toHaveLength(1)
    expect(sdk.clientOptions[0]?.connection).toEqual({
      kind: 'stdio',
      args: ['--no-remote-export'],
    })
    expect(sdk.configs.at(-1)?.workingDirectory).toBe(dir)
    expect(sdk.configs.at(-1)?.remoteSession).toBe('off')
    expect(sdk.configs.at(-1)?.infiniteSessions).toEqual({
      enabled: true,
      backgroundCompactionThreshold: 0.8,
      bufferExhaustionThreshold: 0.95,
    })
    expect(runtime.descriptor()).toMatchObject({
      capabilities: { modelSelection: true, attachments: true },
      models: [{
        ref: 'gpt-5.4-mini',
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        providerId: 'github-copilot',
        contextWindow: 128_000,
      }],
    })

    expect(sdk.setModel).toHaveBeenCalledWith('gpt-5.4-mini')

    const result = await tool?.handler(
      { operations: [{ op: 'clear' }] },
      { toolCallId: 'copilot-call-1' },
    )

    expect(callTool).toHaveBeenCalledWith('copilot-tool-session', {
      kind: 'call_tool',
      callId: 'copilot-call-1',
      name: 'todo_graph',
      input: { operations: [{ op: 'clear' }] },
      cwd: '/workspace/only-on-the-executor',
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

  it('forwards pasted images to the Copilot SDK as blob attachments', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-image-session',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'I can see it.', messageId: 'message-image' },
      id: 'event-image',
      timestamp: new Date().toISOString(),
    })

    await runtime.send(record, {
      text: 'Describe this screenshot.',
      content: [
        { type: 'text', text: 'Describe this screenshot.' },
        {
          type: 'image',
          source: {
            kind: 'base64',
            mediaType: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
      ],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(sdk.sentMessages).toContainEqual({
      prompt: 'Describe this screenshot.',
      attachments: [{
        type: 'blob',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        displayName: 'pasted-image.png',
      }],
    })
    expect(store.get(record.sessionId)?.state.messages[0]).toMatchObject({
      role: 'user',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
      ]),
    })
    await runtime.close()
  })

  it('projects native Copilot usage and compaction lifecycle events', async () => {
    const onState = vi.fn()
    const onCompactStatus = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState,
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
        onCompactStatus,
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-native-compaction',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await store.updatePreferences(record.sessionId, { selectedModel: 'gpt-5.4-mini' })
    await runtime.start()
    await runtime.send(record, { text: 'Observe context.', model: 'gpt-5.4-mini' })

    expect(sdk.listeners.length).toBeGreaterThanOrEqual(1)
    const emit = (event: unknown): void => {
      for (const listener of sdk.listeners) listener(event)
    }
    emit({
      type: 'session.usage_info',
      id: 'usage-1',
      parentId: null,
      timestamp: '2026-08-30T00:00:00.000Z',
      ephemeral: true,
      data: {
        currentTokens: 100_000,
        tokenLimit: 128_000,
        messagesLength: 20,
        systemTokens: 2_000,
        conversationTokens: 94_000,
        toolDefinitionsTokens: 4_000,
      },
    })
    emit({
      type: 'session.compaction_start',
      id: 'compact-start-1',
      parentId: null,
      timestamp: '2026-08-30T00:00:01.000Z',
      data: { currentTokens: 104_000, tokenLimit: 128_000, trigger: 'threshold' },
    })
    emit({
      type: 'session.compaction_complete',
      id: 'compact-complete-1',
      parentId: 'compact-start-1',
      timestamp: '2026-08-30T00:00:02.000Z',
      data: {
        success: true,
        preCompactionTokens: 104_000,
        postCompactionTokens: 32_000,
        systemTokens: 2_000,
        conversationTokens: 32_000,
        toolDefinitionsTokens: 4_000,
        tokenLimit: 128_000,
        messagesRemoved: 30,
      },
    })

    expect(onState).toHaveBeenCalledWith(record, record.state, expect.objectContaining({
      contextWindow: { tokens: 128_000, source: 'api_reported' },
      usage: { inputTokens: 100_000, totalTokens: 100_000 },
      estimator: expect.objectContaining({
        total: { kind: 'provider_reported', confidence: 'exact' },
      }),
    }))
    expect(onState).toHaveBeenCalledWith(record, record.state, expect.objectContaining({
      contextWindow: { tokens: 128_000, source: 'api_reported' },
      usage: { inputTokens: 104_000, totalTokens: 104_000 },
    }))
    expect(onCompactStatus).toHaveBeenNthCalledWith(1, {
      sessionId: record.sessionId,
      kind: 'running',
      trigger: 'auto',
      tokensBefore: 104_000,
      attemptId: 'compact-start-1',
      startedAt: '2026-08-30T00:00:01.000Z',
    })
    expect(onCompactStatus).toHaveBeenNthCalledWith(2, {
      sessionId: record.sessionId,
      kind: 'done',
      attemptId: 'compact-start-1',
      tokensBefore: 104_000,
      tokensAfter: 32_000,
      endedAt: '2026-08-30T00:00:02.000Z',
    })
    expect(onState).toHaveBeenCalledWith(record, record.state, expect.objectContaining({
      usage: { inputTokens: 38_000, totalTokens: 38_000 },
    }))
    await runtime.close()
  })

  it('runs manual compaction through the Copilot history RPC', async () => {
    const onState = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState,
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-manual-compaction',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()

    await runtime.compact(record)

    expect(sdk.compact).toHaveBeenCalledWith({ trigger: 'manual' })
    expect(onState).toHaveBeenCalledWith(record, record.state, expect.objectContaining({
      contextWindow: { tokens: 128_000, source: 'api_reported' },
      usage: { inputTokens: 40_000, totalTokens: 40_000 },
    }))
    await runtime.close()
  })

  it('restores provider context and model from persisted Copilot events', async () => {
    sdk.resumeSucceeds = true
    sdk.historyEvents.push({
      type: 'session.compaction_complete',
      id: 'compact-1',
      parentId: null,
      timestamp: '2026-08-29T23:59:00.000Z',
      data: {
        success: true,
        preCompactionTokens: 60_000,
        postCompactionTokens: 2_299,
        systemTokens: 245,
        conversationTokens: 2_299,
        toolDefinitionsTokens: 6_719,
        tokenLimit: 272_000,
      },
    }, {
      type: 'session.shutdown',
      id: 'shutdown-1',
      parentId: null,
      timestamp: '2026-08-30T00:00:00.000Z',
      data: {
        currentModel: 'gpt-5.4-mini',
        currentTokens: 9_263,
        systemTokens: 245,
        conversationTokens: 2_299,
        toolDefinitionsTokens: 6_719,
      },
    })
    const onState = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState,
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-restored-context',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()

    await runtime.compact(record)

    expect(record.preferences?.selectedModel).toBe('gpt-5.4-mini')
    expect(onState).toHaveBeenCalledWith(record, record.state, expect.objectContaining({
      model: { ref: 'gpt-5.4-mini', provider: 'github-copilot', id: 'gpt-5.4-mini' },
      contextWindow: { tokens: 272_000, source: 'api_reported' },
      usage: { inputTokens: 9_263, totalTokens: 9_263 },
    }))
    await runtime.close()
  })

  it('disables remote export when resuming an existing SDK session', async () => {
    sdk.resumeSucceeds = true
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
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
      sessionId: 'copilot-resume-private',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })

    await runtime.start()
    await runtime.send(record, { text: 'Continue privately.' })

    expect(sdk.resumeConfigs).toHaveLength(1)
    expect(sdk.resumeConfigs[0]?.remoteSession).toBe('off')
    expect(sdk.configs).toHaveLength(0)
    expect(sdk.clientOptions[0]?.connection?.args).toEqual(['--no-remote-export'])
    await runtime.close()
  })

  it('aborts SDK work and cancels pending tools after an SDK timeout', async () => {
    const cancelPending = vi.fn()
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending },
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
      sessionId: 'copilot-timeout',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    sdk.responses.push(new Error('Timeout after 1800000ms waiting for session.idle'))

    await runtime.start()
    await runtime.send(record, { text: 'Continue.' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('error'))

    expect(sdk.abort).toHaveBeenCalledOnce()
    expect(cancelPending).toHaveBeenCalledWith(record.sessionId)
  })

  it('keeps an active Copilot turn alive and aborts only after prolonged inactivity', async () => {
    vi.useFakeTimers()
    try {
      const cancelPending = vi.fn()
      const runtime = new CopilotAgentRuntime({
        store,
        tools: { async callTool() { return { ok: true, content: '' } }, cancelPending },
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
        sessionId: 'copilot-active-timeout',
        agentRuntime: 'copilot',
        config: createConfig({ tools: [] }),
      })

      await runtime.start()
      await runtime.send(record, { text: 'Run a long task.' })
      await vi.advanceTimersByTimeAsync(29 * 60_000)
      for (const listener of [...sdk.listeners]) {
        listener({ type: 'assistant.turn_start', id: 'activity', timestamp: new Date().toISOString(), parentId: null, data: { turnId: '1' } })
      }
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(store.get(record.sessionId)?.state.status).toBe('thinking')
      expect(sdk.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(28 * 60_000)
      await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('error'))
      expect(sdk.abort).toHaveBeenCalledOnce()
      expect(cancelPending).toHaveBeenCalledWith(record.sessionId)
    } finally {
      vi.useRealTimers()
    }
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

  it('registers a live approval before broadcasting its pending state', async () => {
    const callTool = vi.fn(async () => ({ ok: true, content: 'approved result' }))
    let runtime!: CopilotAgentRuntime
    let approvalTriggered = false
    const record = await store.create({
      sessionId: 'copilot-live-approval',
      agentRuntime: 'copilot',
      config: createConfig({
        tools: [{
          name: 'shell',
          description: 'Run a command',
          inputSchema: { type: 'object' },
          requiresApproval: true,
          executionKind: 'executor',
          executionHandler: 'shell',
        }],
      }),
    })
    runtime = new CopilotAgentRuntime({
      store,
      tools: { callTool, cancelPending() {} },
      broadcast: {
        onState(_record, state) {
          if (approvalTriggered || state.status !== 'awaiting_approval') return
          approvalTriggered = true
          void runtime.approve(record, 'call-live')
        },
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })

    await runtime.start()
    await runtime.send(record, { text: 'Run the command.' })
    const tool = sdk.configs.at(-1)?.tools.find((candidate) => candidate.name === 'shell')
    const result = await tool?.handler({ command: 'true' }, { toolCallId: 'call-live' })

    expect(result).toEqual({
      textResultForLlm: 'approved result',
      resultType: 'success',
    })
    const results = store.get(record.sessionId)?.state.messages
      .flatMap((message) => message.content)
      .filter((content) => content.type === 'tool_result' && content.callId === 'call-live')
    expect(results).toEqual([{
      type: 'tool_result',
      callId: 'call-live',
      ok: true,
      content: 'approved result',
    }])
    expect(callTool).toHaveBeenCalledOnce()
    await runtime.close()
  })

  it('persists the final assistant response before marking the Session done', async () => {
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-streamed-message',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'OK', messageId: 'message-1' },
      id: 'event-1',
      timestamp: new Date().toISOString(),
    })
    await runtime.send(record, { text: 'Reply with OK.' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(store.get(record.sessionId)?.state.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
    })
    await runtime.close()
  })
})
