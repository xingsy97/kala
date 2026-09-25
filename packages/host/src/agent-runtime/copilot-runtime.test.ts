import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConfig } from '@agent-kernel/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolDispatcher } from '../loop-types.js'
import { SessionStore } from '../store/session.js'
import { snapshotSidecarPath } from '../store/log.js'
import { CopilotAgentRuntime } from './copilot-runtime.js'
import { MessageAttachmentStore } from '../message-attachment-store.js'

type CapturedTool = {
  name: string
  overridesBuiltInTool?: boolean
  handler(
    args: unknown,
    invocation: { toolCallId: string },
  ): Promise<{ textResultForLlm: string; resultType: string; error?: string }>
}

const sdk = vi.hoisted(() => ({
  clientOptions: [] as Array<{ connection?: { kind: string; args?: readonly string[]; path?: string } }>,
  startError: undefined as Error | undefined,
  configs: [] as Array<{
    tools: CapturedTool[]
    workingDirectory?: string
    availableTools?: readonly string[]
    excludedTools?: readonly string[]
    additionalDirectories?: readonly string[]
    onPermissionRequest?: (request: { kind: string; path?: string; managedApprovalRequired?: boolean }) => unknown
    remoteSession?: string
    infiniteSessions?: {
      enabled?: boolean
      backgroundCompactionThreshold?: number
      bufferExhaustionThreshold?: number
    }
    skipEmbeddingRetrieval?: boolean
    embeddingCacheStorage?: string
    enableOnDemandInstructionDiscovery?: boolean
    enableFileHooks?: boolean
    enableHostGitOperations?: boolean
    enableSessionStore?: boolean
    enableSkills?: boolean
  }>,
  resumeConfigs: [] as Array<{
    tools: CapturedTool[]
    workingDirectory?: string
    availableTools?: readonly string[]
    excludedTools?: readonly string[]
    additionalDirectories?: readonly string[]
    onPermissionRequest?: (request: { kind: string; path?: string; managedApprovalRequired?: boolean }) => unknown
    remoteSession?: string
    infiniteSessions?: {
      enabled?: boolean
      backgroundCompactionThreshold?: number
      bufferExhaustionThreshold?: number
    }
    skipEmbeddingRetrieval?: boolean
    embeddingCacheStorage?: string
    enableOnDemandInstructionDiscovery?: boolean
    enableFileHooks?: boolean
    enableHostGitOperations?: boolean
    enableSessionStore?: boolean
    enableSkills?: boolean
  }>,
  resumeSucceeds: false,
  listeners: [] as Array<(event: unknown) => void>,
  historyEvents: [] as Array<unknown>,
  getEvents: vi.fn(async () => sdk.historyEvents),
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
  ToolSet: class {
    private readonly items: string[] = []
    addBuiltIn(name: string) {
      this.items.push(`builtin:${name}`)
      return this
    }
    toArray() {
      return [...this.items]
    }
  },
  CopilotClient: class {
    constructor(options: { connection?: { kind: string; args?: readonly string[]; path?: string } }) {
      sdk.clientOptions.push(options)
    }
    async start() {
      if (sdk.startError) throw sdk.startError
    }
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
        getEvents: sdk.getEvents,
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
    sdk.startError = undefined
    sdk.listeners.length = 0
    sdk.historyEvents.length = 0
    sdk.responses.length = 0
    sdk.sentMessages.length = 0
    sdk.currentModel = { modelId: 'gpt-5.4-mini', contextTier: 'long_context' }
    sdk.abort.mockClear()
    sdk.setModel.mockClear()
    sdk.compact.mockClear()
    sdk.getEvents.mockReset()
    sdk.getEvents.mockImplementation(async () => sdk.historyEvents)
    dir = mkdtempSync(join(tmpdir(), 'copilot-runtime-tools-'))
    store = new SessionStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function waitForUsage(sessionId: string, inputTokens: number): Promise<void> {
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      if ((store.get(sessionId)?.state.usage.inputTokens ?? 0) >= inputTokens) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`usage projection did not reach ${inputTokens}`)
  }

  it('uses SDK platform-package discovery unless COPILOT_CLI_PATH is supplied', async () => {
    const previous = process.env.COPILOT_CLI_PATH
    try {
      delete process.env.COPILOT_CLI_PATH
      const discovered = new CopilotAgentRuntime({
        store,
        tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
        broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
      }, { enabled: true, sessionsDir: dir })
      await discovered.start()
      expect(sdk.clientOptions.at(-1)?.connection).toEqual({
        kind: 'stdio',
        args: ['--no-remote-export'],
      })
      await discovered.close()

      process.env.COPILOT_CLI_PATH = '/opt/copilot/bin/copilot'
      const overridden = new CopilotAgentRuntime({
        store,
        tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
        broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
      }, { enabled: true, sessionsDir: dir })
      await overridden.start()
      expect(sdk.clientOptions.at(-1)?.connection?.path).toBe('/opt/copilot/bin/copilot')
      await overridden.close()
    } finally {
      if (previous === undefined) delete process.env.COPILOT_CLI_PATH
      else process.env.COPILOT_CLI_PATH = previous
    }
  })

  it('reports a missing SDK CLI clearly instead of silently disabling Copilot', async () => {
    sdk.startError = new Error('Could not resolve a @github/copilot platform package')
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: '' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })

    await runtime.start()

    expect(runtime.descriptor()).toMatchObject({
      available: false,
      status: 'unavailable',
      reason: expect.stringContaining('set COPILOT_CLI_PATH'),
    })
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
    expect(sdk.configs.at(-1)?.workingDirectory).toBe(join(dir, '..'))
    expect(sdk.configs.at(-1)?.remoteSession).toBe('off')
    expect(sdk.configs.at(-1)).toMatchObject({
      additionalDirectories: [],
      skipEmbeddingRetrieval: true,
      embeddingCacheStorage: 'in-memory',
      enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
    })
    expect(sdk.configs.at(-1)?.infiniteSessions).toEqual({
      enabled: true,
      backgroundCompactionThreshold: 0.8,
      bufferExhaustionThreshold: 0.95,
    })
    expect(runtime.descriptor()).toMatchObject({
      capabilities: { queue: true, modelSelection: true, attachments: true },
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

  it('forwards generic files to the Copilot SDK as named blob attachments', async () => {
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
      sessionId: 'copilot-file-session',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'Reviewed.', messageId: 'message-file' },
      id: 'event-file',
      timestamp: new Date().toISOString(),
    })

    await runtime.send(record, {
      text: 'Review this file.',
      content: [
        { type: 'text', text: 'Review this file.' },
        {
          type: 'file',
          name: 'config.json',
          mediaType: 'application/json',
          data: 'eyJvayI6dHJ1ZX0=',
        },
      ],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(sdk.sentMessages).toContainEqual({
      prompt: 'Review this file.',
      attachments: [{
        type: 'blob',
        data: 'eyJvayI6dHJ1ZX0=',
        mimeType: 'application/json',
        displayName: 'config.json',
      }],
    })
    await runtime.close()
  })

  it('resolves Host file references to SDK blobs without exposing Host-only paths or persisting base64', async () => {
    const messageAttachments = new MessageAttachmentStore(join(dir, 'message-attachments'))
    const reference = await messageAttachments.register({
      sessionId: 'copilot-reference-session',
      name: '../config.json',
      mediaType: 'application/json',
      data: Buffer.from('{"ok":true}', 'utf8'),
    })
    const runtime = new CopilotAgentRuntime({
      store,
      messageAttachments,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-reference-session',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: 'Reviewed.', messageId: 'message-reference-file' },
      id: 'event-reference-file',
      timestamp: new Date().toISOString(),
    })

    await runtime.send(record, {
      text: 'Review this file.',
      content: [{ type: 'text', text: 'Review this file.' }, reference],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(sdk.sentMessages).toContainEqual({
      prompt: 'Review this file.',
      attachments: [{
        type: 'blob',
        data: Buffer.from('{"ok":true}', 'utf8').toString('base64'),
        mimeType: 'application/json',
        displayName: 'config.json',
      }],
    })
    expect(JSON.stringify(sdk.sentMessages)).not.toContain(messageAttachments.resolve(record.sessionId, reference).path)
    const config = sdk.configs.at(-1)
    expect(config?.workingDirectory).toBe(join(dir, '..'))
    expect(config?.availableTools).toContain('builtin:view')
    expect(config?.excludedTools).toEqual(['mcp:*'])
    const path = messageAttachments.resolve(record.sessionId, reference).path
    expect(config?.onPermissionRequest?.({ kind: 'read', path })).toEqual({ kind: 'approve-once' })
    expect(config?.onPermissionRequest?.({ kind: 'read', path: join(dir, 'secret.txt') })).toMatchObject({ kind: 'reject' })
    expect(config?.onPermissionRequest?.({ kind: 'read', path, managedApprovalRequired: true })).toMatchObject({ kind: 'reject' })
    const persisted = readFileSync(snapshotSidecarPath(record.logPath), 'utf8')
    expect(persisted).toContain(reference.source.attachmentId)
    expect(persisted).not.toContain(Buffer.from('{"ok":true}', 'utf8').toString('base64'))
    await runtime.close()
  })

  it('externalizes inline user images before persisting an external Runtime snapshot', async () => {
    const messageAttachments = new MessageAttachmentStore(join(dir, 'message-attachments'))
    const runtime = new CopilotAgentRuntime({
      store,
      messageAttachments,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-inline-image', agentRuntime: 'copilot', config: createConfig({ tools: [] }),
    })
    await runtime.start()
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
    sdk.responses.push({
      type: 'assistant.message', data: { content: 'Seen.', messageId: 'message-image-seen' },
      id: 'event-image-seen', timestamp: new Date().toISOString(),
    })
    await runtime.send(record, {
      text: 'Inspect this image.',
      content: [{ type: 'text', text: 'Inspect this image.' }, { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: imageData } }],
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))
    const userImage = store.get(record.sessionId)?.state.messages[0]?.content[1]
    expect(userImage).toMatchObject({ type: 'file', mediaType: 'image/png', source: { kind: 'host_ref' } })
    const persisted = readFileSync(snapshotSidecarPath(record.logPath), 'utf8')
    expect(persisted).not.toContain(imageData)
    expect(sdk.sentMessages.at(-1)?.attachments).toEqual([expect.objectContaining({ type: 'blob', data: imageData, mimeType: 'image/png' })])
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
      type: 'assistant.usage',
      id: 'assistant-usage-1',
      parentId: null,
      timestamp: '2026-08-30T00:00:00.500Z',
      data: {
        model: 'gpt-5.4-mini',
        inputTokens: 91_000,
        outputTokens: 1_700,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 3_000,
        apiCallId: 'api-usage-1',
      },
    })
    await waitForUsage(record.sessionId, 91_000)
    expect(store.get(record.sessionId)?.state.usage).toMatchObject({
      inputTokens: 91_000,
      outputTokens: 1_700,
      cacheReadTokens: 20_000,
      cacheCreationTokens: 3_000,
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

    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ sessionId: record.sessionId }), expect.any(Object), expect.objectContaining({
      contextWindow: { tokens: 128_000, source: 'api_reported' },
      usage: { inputTokens: 100_000, totalTokens: 100_000 },
      estimator: expect.objectContaining({
        total: { kind: 'provider_reported', confidence: 'exact' },
      }),
    }))
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ sessionId: record.sessionId }), expect.any(Object), expect.objectContaining({
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
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ sessionId: record.sessionId }), expect.any(Object), expect.objectContaining({
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

  it('restores provider context and model from the bounded Host context snapshot', async () => {
    sdk.resumeSucceeds = true
    sdk.getEvents.mockRejectedValue(new Error('full SDK history must not be loaded'))
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
    await store.updateRuntimeContextSnapshot(record, {
      model: { ref: 'previous-model', provider: 'github-copilot', id: 'previous-model' },
      contextWindow: { tokens: 272_000, source: 'api_reported' },
      usage: { inputTokens: 9_263, totalTokens: 9_263 },
      breakdown: {
        system: 245,
        transcript: 2_299,
        tools: 6_719,
        memory: 0,
        attachments: 0,
        pendingUserInput: 0,
      },
      estimator: {
        total: { kind: 'provider_reported', confidence: 'exact' },
        breakdown: { kind: 'heuristic', confidence: 'estimated' },
        version: 'copilot-sdk-usage-info-v1',
      },
      updatedAt: Date.now(),
    })
    await runtime.start()

    await runtime.compact(record)

    expect(record.preferences?.selectedModel).toBe('gpt-5.4-mini')
    expect(onState).toHaveBeenCalledWith(record, record.state, expect.objectContaining({
      model: { ref: 'gpt-5.4-mini', provider: 'github-copilot', id: 'gpt-5.4-mini' },
      contextWindow: { tokens: 272_000, source: 'api_reported' },
      usage: { inputTokens: 9_263, totalTokens: 9_263 },
    }))
    expect(sdk.getEvents).not.toHaveBeenCalled()
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

  it('publishes local images before persisting a final assistant response', async () => {
    const publishLocalImages = vi.fn(async (_sessionId, _record, message) => ({
      ...message,
      content: message.content.map((part) => part.type === 'text'
        ? { ...part, text: part.text.replace('/repo/design.png', 'artifact://published-image?mediaType=image%2Fpng') }
        : part),
    }))
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      publishLocalImages,
      broadcast: {
        onState() {},
        onTokenDelta() {},
        onApprovalRequired() {},
        onError() {},
      },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-local-image',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    sdk.responses.push({
      type: 'assistant.message',
      data: { content: '![Design](/repo/design.png)', messageId: 'message-image' },
      id: 'event-image',
      timestamp: new Date().toISOString(),
    })

    await runtime.send(record, { text: 'Show the image.' })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    expect(publishLocalImages).toHaveBeenCalledOnce()
    expect(store.get(record.sessionId)?.state.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '![Design](artifact://published-image?mediaType=image%2Fpng)' }],
    })
    await runtime.close()
  })

  it('persists ordered reasoning and every complete assistant chunk instead of only sendAndWait final content', async () => {
    let resolveResponse!: (value: unknown) => void
    const response = new Promise((resolve) => { resolveResponse = resolve })
    sdk.responses.push(response)
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-complete-events',
      agentRuntime: 'copilot',
      config: createConfig({ tools: [] }),
    })
    await runtime.start()
    await runtime.send(record, { text: 'Investigate then answer.' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(1))
    const emit = (event: unknown) => [...sdk.listeners].forEach((listener) => listener(event))
    const timestamp = new Date().toISOString()
    emit({ type: 'assistant.reasoning', id: 'reasoning-1', parentId: null, timestamp, data: { reasoningId: 'r1', content: 'First inspect the state.' } })
    emit({ type: 'assistant.message', id: 'message-1', parentId: 'reasoning-1', timestamp, data: { messageId: 'm1', apiCallId: 'api-1', chunkIndex: 0, chunkCount: 2, content: 'I will inspect it.' } })
    emit({ type: 'assistant.message', id: 'message-2', parentId: 'message-1', timestamp, data: { messageId: 'm2', apiCallId: 'api-1', chunkIndex: 1, chunkCount: 2, content: 'The final answer is preserved.', outputTokens: 12 } })
    resolveResponse({ type: 'assistant.message', id: 'message-2', parentId: 'message-1', timestamp, data: { messageId: 'm2', apiCallId: 'api-1', content: 'The final answer is preserved.', outputTokens: 12 } })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))

    const assistantContent = store.get(record.sessionId)?.state.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content) ?? []
    expect(assistantContent).toEqual([
      expect.objectContaining({ type: 'thinking', text: 'First inspect the state.' }),
      expect.objectContaining({ type: 'text', text: 'I will inspect it.' }),
      expect.objectContaining({ type: 'text', text: 'The final answer is preserved.' }),
    ])
    expect(store.get(record.sessionId)?.state.usage.outputTokens).toBe(12)
    await runtime.close()
  })

  it('persists a distinct sendAndWait final event even when its text equals an intermediate event', async () => {
    let resolveResponse!: (value: unknown) => void
    sdk.responses.push(new Promise((resolve) => { resolveResponse = resolve }))
    const runtime = new CopilotAgentRuntime({
      store,
      tools: { async callTool() { return { ok: true, content: 'unused' } }, cancelPending() {} },
      broadcast: { onState() {}, onTokenDelta() {}, onApprovalRequired() {}, onError() {} },
    }, { enabled: true, sessionsDir: dir })
    const record = await store.create({
      sessionId: 'copilot-final-fallback', agentRuntime: 'copilot', config: createConfig({ tools: [] }),
    })
    await runtime.start()
    await runtime.send(record, { text: 'Narrate then answer.' })
    await vi.waitFor(() => expect(sdk.sentMessages).toHaveLength(1))
    const timestamp = new Date().toISOString()
    for (const listener of sdk.listeners) listener({
      type: 'assistant.message', id: 'message-intermediate', parentId: null, timestamp,
      data: { messageId: 'm-intermediate', content: 'I will inspect it.' },
    })
    resolveResponse({
      type: 'assistant.message', id: 'message-final', parentId: 'message-intermediate', timestamp,
      data: { messageId: 'm-final', content: 'I will inspect it.' },
    })
    await vi.waitFor(() => expect(store.get(record.sessionId)?.state.status).toBe('done'))
    expect(store.get(record.sessionId)?.state.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((content) => content.type === 'text')
      .map((content) => content.text)).toEqual(['I will inspect it.', 'I will inspect it.'])
    await runtime.close()
  })
})
