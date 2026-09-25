import { join } from 'node:path'

import type {
  AgentState,
  ApprovalMode,
  Message,
  MessageContent,
  PendingToolCall,
  ToolSchema,
} from '@agent-kernel/kernel'
import {
  COPILOT_AGENT_RUNTIME_CAPABILITIES,
  type AgentRuntimeDescriptor,
  type ContextUsageSnapshot,
  type ModelInfo,
} from '@agent-kernel/shared'
import {
  CopilotClient,
  RuntimeConnection,
  ToolSet,
  type ModelInfo as CopilotModelInfo,
  type MessageOptions,
  type CopilotSession,
  type SessionEvent,
  type Tool,
  type ToolResultObject,
} from '@github/copilot-sdk'

import type { SessionRecord } from '../store/session.js'
import type {
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeSendInput,
} from './types.js'

type ApprovalDecision = { approved: true } | { approved: false; reason?: string }

type PendingApproval = {
  resolve(decision: ApprovalDecision): void
}

type TurnCapture = {
  assistantEventIds: Set<string>
  reasoningTexts: Set<string>
  eventIds: Set<string>
  projections: Promise<void>[]
  projectionError?: unknown
}

const COPILOT_INACTIVITY_TIMEOUT_MS = 30 * 60_000
const COPILOT_SDK_TURN_TIMEOUT_MS = 24 * 60 * 60_000

export type CopilotAgentRuntimeOptions = {
  enabled: boolean
  sessionsDir: string
  gitHubToken?: string
}

export class CopilotAgentRuntime implements AgentRuntime {
  readonly id = 'copilot' as const
  private client: CopilotClient | undefined
  private readonly sessions = new Map<string, CopilotSession>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly cancelledCalls = new Set<string>()
  private readonly cancelledSessions = new Set<string>()
  private readonly compactions = new Map<string, { attemptId: string; tokensBefore: number }>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly accountedUsageCallIds = new Set<string>()
  private readonly turnCaptures = new Map<string, TurnCapture>()
  private status: AgentRuntimeDescriptor['status']
  private reason: string | undefined
  private models: readonly ModelInfo[] = []

  constructor(
    private readonly context: AgentRuntimeContext,
    private readonly options: CopilotAgentRuntimeOptions,
  ) {
    this.status = options.enabled ? 'unavailable' : 'disabled'
    this.reason = options.enabled ? 'Copilot runtime is starting' : 'Copilot runtime is disabled'
  }

  async start(): Promise<void> {
    if (!this.options.enabled) return
    try {
      const configuredCliPath = process.env.COPILOT_CLI_PATH?.trim()
      this.client = new CopilotClient({
        mode: 'empty',
        connection: RuntimeConnection.forStdio({
          args: ['--no-remote-export'],
          // With no override, the official SDK discovers its own platform package.
          ...(configuredCliPath ? { path: configuredCliPath } : {}),
        }),
        baseDirectory: join(this.options.sessionsDir, '..', 'copilot-runtime'),
        ...(this.options.gitHubToken ? { gitHubToken: this.options.gitHubToken, useLoggedInUser: false } : {}),
      })
      await this.client.start()
      const auth = await this.client.getAuthStatus()
      if (!auth.isAuthenticated) throw new Error('Copilot CLI is not authenticated')
      this.models = (await this.client.listModels()).map(modelInfo)
      this.status = 'ready'
      this.reason = undefined
    } catch (error) {
      this.status = 'unavailable'
      this.reason = copilotStartupFailureReason(error)
      await this.client?.stop().catch(() => [])
      this.client = undefined
    }
  }

  descriptor(): AgentRuntimeDescriptor {
    return {
      id: this.id,
      label: 'GitHub Copilot',
      description: 'Official GitHub Copilot SDK agent runtime',
      available: this.status === 'ready',
      status: this.status,
      ...(this.reason ? { reason: this.reason } : {}),
      version: '1.0.11',
      capabilities: COPILOT_AGENT_RUNTIME_CAPABILITIES,
      models: this.models,
    }
  }

  async send(record: SessionRecord, input: AgentRuntimeSendInput): Promise<void> {
    const session = await this.ensureSession(record, input.model)
    if (input.model) await session.setModel(input.model)
    this.cancelledSessions.delete(record.sessionId)
    await this.project(record, 'copilot.user_message', {
      text: input.text,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.queuedAt ? { queuedAt: input.queuedAt } : {}),
    }, (state) => ({
      ...state,
      messages: [...state.messages, userMessage(input)],
      status: 'thinking',
      pendingCalls: [],
      error: undefined,
    }))
    void this.runTurn(record, session, input)
  }

  async cancel(record: SessionRecord): Promise<void> {
    const session = this.sessions.get(record.sessionId)
    this.cancelledSessions.add(record.sessionId)
    if (session) await session.abort()
    for (const call of record.state.pendingCalls) {
      this.cancelledCalls.add(approvalKey(record.sessionId, call.callId))
    }
    this.context.tools.cancelPending(record.sessionId)
    for (const [key, approval] of this.approvals) {
      if (!key.startsWith(`${record.sessionId}:`)) continue
      approval.resolve({ approved: false, reason: 'cancelled' })
      this.approvals.delete(key)
    }
    await this.project(record, 'copilot.cancelled', {}, (state) => ({
      ...state,
      status: 'done',
      pendingCalls: [],
      error: undefined,
    }))
  }

  async approve(record: SessionRecord, callId: string): Promise<void> {
    const pending = this.approvals.get(approvalKey(record.sessionId, callId))
    if (!pending) {
      await this.expireUnresumableApproval(record, callId)
      return
    }
    pending.resolve({ approved: true })
    this.approvals.delete(approvalKey(record.sessionId, callId))
  }

  async reject(record: SessionRecord, callId: string, reason?: string): Promise<void> {
    const pending = this.approvals.get(approvalKey(record.sessionId, callId))
    if (!pending) {
      await this.expireUnresumableApproval(record, callId)
      return
    }
    pending.resolve({ approved: false, ...(reason ? { reason } : {}) })
    this.approvals.delete(approvalKey(record.sessionId, callId))
  }

  async setApprovalMode(record: SessionRecord, mode: ApprovalMode): Promise<void> {
    await this.project(record, 'copilot.approval_mode_changed', { mode }, (state) => ({
      ...state,
      approvalMode: mode,
    }))
  }

  async setModel(record: SessionRecord, model: string): Promise<void> {
    const session = await this.ensureSession(record)
    await session.setModel(model)
  }

  async compact(record: SessionRecord): Promise<void> {
    const session = await this.ensureSession(record, record.preferences?.selectedModel)
    const result = await session.rpc.history.compact({ trigger: 'manual' })
    if (!result.success) throw new Error('Copilot compaction did not complete successfully')
    if (result.contextWindow) {
      this.context.broadcast.onState(
        record,
        record.state,
        copilotContextSnapshot(record, result.contextWindow),
      )
    }
  }

  async confirmModelChange(record: SessionRecord, from: string | undefined, to: string): Promise<void> {
    if (from === to) return
    await this.project(record, 'copilot.model_changed', {
      ...(from ? { from } : {}),
      to,
    }, (state) => ({
      ...state,
      messages: [...state.messages, {
        role: 'system',
        content: [{ type: 'text', text: `Model changed${from ? `: ${from} → ${to}` : ` to ${to}`}` }],
        metadata: {
          kind: 'model_changed',
          ...(from ? { from } : {}),
          to,
        },
      }],
    }))
  }

  async delete(record: SessionRecord): Promise<void> {
    const session = this.sessions.get(record.sessionId)
    this.cancelledSessions.add(record.sessionId)
    if (session) {
      await session.disconnect()
      this.sessions.delete(record.sessionId)
    }
    await this.client?.deleteSession(record.externalSessionId ?? record.sessionId).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.sessions.clear()
    this.cancelledSessions.clear()
    if (this.client) await this.client.stop()
    this.client = undefined
  }

  private async ensureSession(record: SessionRecord, model?: string): Promise<CopilotSession> {
    const existing = this.sessions.get(record.sessionId)
    if (existing) return existing
    if (!this.client || this.status !== 'ready') {
      throw new Error(this.reason ?? 'Copilot runtime is unavailable')
    }
    const config = this.sessionConfig(record, model)
    let session: CopilotSession
    try {
      session = await this.client.resumeSession(record.externalSessionId ?? record.sessionId, {
        ...config,
        continuePendingWork: false,
      })
    } catch {
      session = await this.client.createSession({
        ...config,
        sessionId: record.externalSessionId ?? record.sessionId,
      })
    }
    session.on((event) => this.handleEvent(record, event))
    this.sessions.set(record.sessionId, session)
    await this.restorePersistedContext(record, session)
    return session
  }

  private async restorePersistedContext(record: SessionRecord, session: CopilotSession): Promise<void> {
    const currentModel = await session.rpc.model.getCurrent()
    const model = currentModel.modelId ?? record.preferences?.selectedModel
    if (model && record.preferences?.selectedModel !== model) {
      await this.context.store.updatePreferences(record.sessionId, { selectedModel: model })
    }
    const persisted = record.runtimeContextSnapshot
    if (!persisted) return
    const snapshot = model && persisted.model.ref !== model
      ? { ...persisted, model: { ref: model, provider: 'github-copilot', id: model } }
      : persisted
    this.context.broadcast.onState(record, record.state, snapshot)
  }

  private sessionConfig(record: SessionRecord, model?: string) {
    const tools = record.config.tools.map((schema) => this.tool(record, schema))
    const workingDirectory = join(this.options.sessionsDir, '..')
    return {
      clientName: 'agent-runlab',
      ...(model ? { model } : {}),
      // The Copilot CLI runs with the Host, while record.state.cwd belongs to
      // the remote Workspace Executor. Never expose Host-only paths as message
      // attachments; persisted attachments are sent to the SDK as blobs below.
      workingDirectory,
      systemMessage: {
        mode: 'replace' as const,
        content: record.config.systemPrompt ?? 'You are an AI coding agent.',
      },
      tools,
      availableTools: [
        ...tools.map((tool) => `custom:${tool.name}`),
        ...new ToolSet().addBuiltIn('view').toArray(),
      ],
      excludedTools: ['mcp:*'],
      additionalDirectories: [],
      onPermissionRequest: (request: { kind: string; path?: string; managedApprovalRequired?: boolean }) => {
        if (
          request.kind === 'read'
          && !request.managedApprovalRequired
          && typeof request.path === 'string'
          && this.context.messageAttachments?.allowsSdkRead(record.sessionId, request.path)
        ) return { kind: 'approve-once' as const }
        return {
          kind: 'reject' as const,
          feedback: 'Copilot may only read the exact Host-managed file attached to this message.',
        }
      },
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      remoteSession: 'off' as const,
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.8,
        bufferExhaustionThreshold: 0.95,
      },
      coauthorEnabled: false,
      enableExperimentalMode: false,
      skipEmbeddingRetrieval: true,
      embeddingCacheStorage: 'in-memory' as const,
      enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
    }
  }

  private tool(record: SessionRecord, schema: ToolSchema): Tool {
    return {
      name: schema.name,
      description: schema.description,
      parameters: schema.inputSchema,
      skipPermission: true,
      overridesBuiltInTool: true,
      handler: async (args, invocation) => {
        const input = asRecord(args)
        const pending: PendingToolCall = {
          callId: invocation.toolCallId,
          name: schema.name,
          input,
          status: 'dispatched',
        }
        if (record.state.approvalMode === 'deny' && schema.requiresApproval) {
          await this.projectToolCall(record, { ...pending, status: 'awaiting_approval' })
          await this.projectToolResult(record, pending, false, 'rejected by approval policy')
          return toolResult(false, 'rejected by approval policy', 'denied')
        }
        if (requiresApproval(record.state.approvalMode, schema.requiresApproval)) {
          pending.status = 'awaiting_approval'
          const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
            this.approvals.set(approvalKey(record.sessionId, pending.callId), { resolve })
          })
          try {
            await this.projectToolCall(record, pending)
            this.context.broadcast.onApprovalRequired(record.sessionId)
          } catch (error) {
            this.approvals.delete(approvalKey(record.sessionId, pending.callId))
            throw error
          }
          const decision = await decisionPromise
          if (!decision.approved) {
            await this.projectToolResult(record, pending, false, decision.reason ?? 'rejected by user')
            return toolResult(false, decision.reason ?? 'rejected by user', 'rejected')
          }
          await this.project(record, 'copilot.tool_approved', { callId: pending.callId }, (state) => ({
            ...state,
            status: 'executing_tools',
            pendingCalls: state.pendingCalls.map((call) => call.callId === pending.callId
              ? { ...call, status: 'dispatched' }
              : call),
            error: undefined,
          }))
        } else {
          await this.projectToolCall(record, pending)
        }
        const result = await this.context.tools.callTool(record.sessionId, {
          kind: 'call_tool',
          callId: pending.callId,
          name: pending.name,
          input: pending.input,
          ...(record.state.cwd ? { cwd: record.state.cwd } : {}),
        })
        const callKey = approvalKey(record.sessionId, pending.callId)
        if (this.cancelledCalls.delete(callKey)) {
          return toolResult(false, 'cancelled', 'failure')
        }
        await this.projectToolResult(record, pending, result.ok, result.content)
        return toolResult(result.ok, result.content, result.ok ? 'success' : 'failure')
      },
    }
  }

  private handleEvent(record: SessionRecord, event: SessionEvent): void {
    if (event.type === 'assistant.usage') {
      if (event.data.apiCallId) this.accountedUsageCallIds.add(event.data.apiCallId)
      void this.project(record, 'copilot.assistant_usage', nativeEventPayload(event), (state) => ({
        ...state,
        usage: {
          inputTokens: state.usage.inputTokens + (event.data.inputTokens ?? 0),
          outputTokens: state.usage.outputTokens + (event.data.outputTokens ?? 0),
          cacheCreationTokens: state.usage.cacheCreationTokens + (event.data.cacheWriteTokens ?? 0),
          cacheReadTokens: state.usage.cacheReadTokens + (event.data.cacheReadTokens ?? 0),
        },
      }))
      return
    }
    if (event.type === 'session.usage_info') {
      this.context.broadcast.onState(record, record.state, copilotContextSnapshot(record, event.data))
      return
    }
    if (event.type === 'session.compaction_start') {
      const attemptId = event.id
      const tokensBefore = event.data.currentTokens ?? event.data.conversationTokens ?? 0
      this.compactions.set(record.sessionId, { attemptId, tokensBefore })
      if (event.data.tokenLimit && event.data.currentTokens !== undefined) {
        this.context.broadcast.onState(
          record,
          record.state,
          copilotContextSnapshot(record, {
            currentTokens: event.data.currentTokens,
            tokenLimit: event.data.tokenLimit,
            ...(event.data.systemTokens !== undefined ? { systemTokens: event.data.systemTokens } : {}),
            ...(event.data.conversationTokens !== undefined ? { conversationTokens: event.data.conversationTokens } : {}),
            ...(event.data.toolDefinitionsTokens !== undefined ? { toolDefinitionsTokens: event.data.toolDefinitionsTokens } : {}),
          }),
        )
      }
      this.context.broadcast.onCompactStatus?.({
        sessionId: record.sessionId,
        kind: 'running',
        trigger: event.data.trigger === 'manual' ? 'manual' : 'auto',
        tokensBefore,
        attemptId,
        startedAt: event.timestamp,
      })
      return
    }
    if (event.type === 'session.compaction_complete') {
      const active = this.compactions.get(record.sessionId)
      const attemptId = active?.attemptId ?? event.id
      this.compactions.delete(record.sessionId)
      if (event.data.success) {
        const tokensAfter = event.data.postCompactionTokens ?? event.data.conversationTokens ?? 0
        this.context.broadcast.onCompactStatus?.({
          sessionId: record.sessionId,
          kind: 'done',
          attemptId,
          tokensBefore: event.data.preCompactionTokens ?? active?.tokensBefore ?? 0,
          tokensAfter,
          endedAt: event.timestamp,
        })
        const currentTokens = completeCompactionContextTokens(event.data)
        if (event.data.tokenLimit && currentTokens !== undefined) {
          this.context.broadcast.onState(record, record.state, copilotContextSnapshot(record, {
            currentTokens,
            tokenLimit: event.data.tokenLimit,
            ...(event.data.systemTokens !== undefined ? { systemTokens: event.data.systemTokens } : {}),
            ...(event.data.conversationTokens !== undefined ? { conversationTokens: event.data.conversationTokens } : {}),
            ...(event.data.toolDefinitionsTokens !== undefined ? { toolDefinitionsTokens: event.data.toolDefinitionsTokens } : {}),
          }))
        }
      } else {
        this.context.broadcast.onCompactStatus?.({
          sessionId: record.sessionId,
          kind: 'error',
          attemptId,
          message: event.data.error ?? 'Copilot compaction failed',
          endedAt: event.timestamp,
        })
      }
      return
    }
    if (event.type === 'assistant.message_delta') {
      this.context.broadcast.onTokenDelta(record.sessionId, event.data.deltaContent)
      return
    }
    if ((event.type === 'assistant.message' || event.type === 'assistant.reasoning') && !event.agentId) {
      const capture = this.turnCaptures.get(record.sessionId)
      if (!capture || capture.eventIds.has(event.id)) return
      capture.eventIds.add(event.id)
      const content: MessageContent[] = []
      const reasoningTexts: string[] = []
      let assistantText = ''
      if (event.type === 'assistant.reasoning') {
        const text = event.data.content.trim()
        if (text && !capture.reasoningTexts.has(text)) {
          reasoningTexts.push(text)
          content.push({ type: 'thinking', text: event.data.content, provider: 'github-copilot' })
        }
      } else {
        const reasoning = event.data.reasoningText?.trim()
        if (reasoning && !capture.reasoningTexts.has(reasoning)) {
          reasoningTexts.push(reasoning)
          content.push({ type: 'thinking', text: event.data.reasoningText!, provider: 'github-copilot' })
        }
        assistantText = event.data.content.trim()
        if (assistantText) content.push({ type: 'text', text: event.data.content })
      }
      if (content.length > 0) {
        // Reserve content immediately to de-duplicate back-to-back complete
        // events. A failed projection fails the whole turn below rather than
        // allowing session_idle to hide the missing transcript content.
        for (const text of reasoningTexts) capture.reasoningTexts.add(text)
        if (assistantText) capture.assistantEventIds.add(event.id)
        const outputTokens = event.type === 'assistant.message'
          ? this.takeOutputTokens(event.data.apiCallId, event.data.outputTokens)
          : 0
        const projection = this.projectAssistantContent(
          record,
          event.type === 'assistant.reasoning' ? 'copilot.assistant_reasoning' : 'copilot.assistant_message',
          nativeEventPayload(event),
          content,
          outputTokens,
        ).catch((error) => { capture.projectionError ??= error })
        capture.projections.push(projection)
      }
      return
    }
    if (event.type === 'assistant.reasoning_delta' || event.type === 'session.idle') return
    if (event.type === 'session.error') {
      void this.project(record, 'copilot.session_error', nativeEventPayload(event), (state) => ({
        ...state,
        status: 'error',
        pendingCalls: [],
        error: event.data.message,
      }))
      this.context.broadcast.onError(record.sessionId, event.data.message)
    }
  }

  private async runTurn(record: SessionRecord, session: CopilotSession, input: AgentRuntimeSendInput): Promise<void> {
    const capture: TurnCapture = {
      assistantEventIds: new Set(), reasoningTexts: new Set(), eventIds: new Set(), projections: [],
    }
    this.turnCaptures.set(record.sessionId, capture)
    try {
      const response = await sendAndWaitWithActivityTimeout(
        session,
        await copilotMessageOptions(this.context, record, input),
      )
      if (this.cancelledSessions.delete(record.sessionId)) return
      await Promise.all(capture.projections)
      if (capture.projectionError) throw capture.projectionError
      const pendingProjection = this.tails.get(record.sessionId)
      if (pendingProjection) await pendingProjection
      if (!response && capture.assistantEventIds.size === 0) throw new Error('Copilot turn completed without an assistant message')
      const content: MessageContent[] = []
      if (response?.data.reasoningText && !capture.reasoningTexts.has(response.data.reasoningText.trim())) {
        content.push({ type: 'thinking', text: response.data.reasoningText, provider: 'github-copilot' })
      }
      if (response?.data.content && !capture.assistantEventIds.has(response.id)) {
        content.push({ type: 'text', text: response.data.content })
      }
      if (content.length > 0) {
        const assistantMessage = this.context.publishLocalImages
          ? await this.context.publishLocalImages(record.sessionId, record, { role: 'assistant', content })
          : { role: 'assistant' as const, content }
        const outputTokens = this.takeOutputTokens(response?.data.apiCallId, response?.data.outputTokens)
        await this.project(record, 'copilot.assistant_message', response ? nativeEventPayload(response) : {}, (state) => ({
          ...state,
          messages: [...state.messages, assistantMessage],
          usage: outputTokens > 0
            ? { ...state.usage, outputTokens: state.usage.outputTokens + outputTokens }
            : state.usage,
          status: 'thinking',
          pendingCalls: [],
          error: undefined,
        }))
      }
      await this.project(record, 'copilot.session_idle', response ? nativeEventPayload(response) : {}, (state) => ({
        ...state,
        status: 'done',
        pendingCalls: [],
        error: undefined,
      }))
    } catch (error) {
      if (this.cancelledSessions.delete(record.sessionId)) return
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('waiting for session.idle') || message.includes('without Copilot session activity')) {
        await session.abort().catch(() => undefined)
        for (const call of record.state.pendingCalls) {
          this.cancelledCalls.add(approvalKey(record.sessionId, call.callId))
        }
        this.context.tools.cancelPending(record.sessionId)
      }
      await this.project(record, 'copilot.session_error', { message }, (state) => ({
        ...state,
        status: 'error',
        pendingCalls: [],
        error: message,
      }))
      this.context.broadcast.onError(record.sessionId, message)
    } finally {
      if (this.turnCaptures.get(record.sessionId) === capture) this.turnCaptures.delete(record.sessionId)
    }
  }

  private takeOutputTokens(apiCallId: string | undefined, outputTokens: number | undefined): number {
    if (!apiCallId || this.accountedUsageCallIds.has(apiCallId)) return 0
    const tokens = outputTokens ?? 0
    if (tokens > 0) this.accountedUsageCallIds.add(apiCallId)
    return tokens
  }

  private async projectToolCall(record: SessionRecord, pending: PendingToolCall): Promise<void> {
    await this.project(record, 'copilot.tool_call', {
      callId: pending.callId,
      name: pending.name,
      input: pending.input,
    }, (state) => ({
      ...state,
      messages: [...state.messages, {
        role: 'assistant',
        content: [{
          type: 'tool_call',
          callId: pending.callId,
          name: pending.name,
          input: pending.input,
        }],
      }],
      status: pending.status === 'awaiting_approval' ? 'awaiting_approval' : 'executing_tools',
      pendingCalls: [...state.pendingCalls.filter((call) => call.callId !== pending.callId), pending],
      error: undefined,
    }))
  }

  private async projectToolResult(
    record: SessionRecord,
    pending: PendingToolCall,
    ok: boolean,
    content: string,
  ): Promise<void> {
    await this.project(record, 'copilot.tool_result', { callId: pending.callId, ok }, (state) => ({
      ...state,
      messages: [...state.messages, {
        role: 'tool',
        content: [{ type: 'tool_result', callId: pending.callId, ok, content }],
      }],
      status: 'thinking',
      pendingCalls: state.pendingCalls.filter((call) => call.callId !== pending.callId),
      error: undefined,
    }))
  }

  private async expireUnresumableApproval(
    record: SessionRecord,
    callId: string,
  ): Promise<void> {
    const latest = this.context.store.get(record.sessionId) ?? record
    const pending = latest.state.pendingCalls.find((call) => call.callId === callId)
    if (!pending) return
    const message = 'Copilot approval could not be resumed after host restart'
    await this.project(
      latest,
      'copilot.approval_expired_after_restart',
      { callId },
      (state) => ({
        ...state,
        messages: [...state.messages, {
          role: 'tool',
          content: [{ type: 'tool_result', callId, ok: false, content: message }],
        }],
        status: 'error',
        pendingCalls: state.pendingCalls.filter((call) => call.callId !== callId),
        error: message,
      }),
    )
  }

  private async projectAssistantContent(
    record: SessionRecord,
    action: string,
    payload: Record<string, unknown>,
    content: MessageContent[],
    outputTokens: number,
  ): Promise<void> {
    const previous = this.tails.get(record.sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const latest = this.context.store.get(record.sessionId) ?? record
      const message: Message = { role: 'assistant', content }
      const assistantMessage = this.context.publishLocalImages
        ? await this.context.publishLocalImages(record.sessionId, latest, message)
        : message
      const projected = {
        ...latest.state,
        messages: [...latest.state.messages, assistantMessage],
        usage: outputTokens > 0
          ? { ...latest.state.usage, outputTokens: latest.state.usage.outputTokens + outputTokens }
          : latest.state.usage,
        ...(latest.state.pendingCalls.length > 0
          ? {
              status: latest.state.status === 'awaiting_approval' ? 'awaiting_approval' as const : 'executing_tools' as const,
              pendingCalls: latest.state.pendingCalls,
            }
          : { status: 'thinking' as const, pendingCalls: [] as const }),
        error: undefined,
        cursor: latest.state.cursor + 1,
      } as AgentState
      const next = await this.externalizeInlineImages(record.sessionId, projected)
      await this.context.store.recordRuntimeProjection(record.sessionId, next, action, payload)
      this.context.broadcast.onState(latest, next)
    })
    this.tails.set(record.sessionId, current)
    try {
      await current
    } finally {
      if (this.tails.get(record.sessionId) === current) this.tails.delete(record.sessionId)
    }
  }

  private async externalizeInlineImages(sessionId: string, state: AgentState): Promise<AgentState> {
    const store = this.context.messageAttachments
    if (!store) return state
    let changed = false
    const messages: Message[] = []
    for (const [messageIndex, message] of state.messages.entries()) {
      const content: MessageContent[] = []
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type !== 'image' || block.source.kind !== 'base64' || !block.source.data) {
          content.push(block)
          continue
        }
        const extension = imageExtension(block.source.mediaType)
        const file = await store.register({
          sessionId,
          name: `pasted-image-${messageIndex + 1}-${contentIndex + 1}.${extension}`,
          mediaType: block.source.mediaType,
          data: Buffer.from(block.source.data, 'base64'),
        })
        await store.commitReferences(sessionId, [file])
        content.push(file)
        changed = true
      }
      messages.push(changed ? { ...message, content } : message)
    }
    return changed ? { ...state, messages } as AgentState : state
  }

  private async project(
    record: SessionRecord,
    action: string,
    payload: Record<string, unknown>,
    update: (state: AgentState) => Omit<AgentState, 'cursor'>,
  ): Promise<void> {
    const previous = this.tails.get(record.sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const latest = this.context.store.get(record.sessionId) ?? record
      const projected = { ...update(latest.state), cursor: latest.state.cursor + 1 } as AgentState
      const next = await this.externalizeInlineImages(record.sessionId, projected)
      await this.context.store.recordRuntimeProjection(record.sessionId, next, action, payload)
      this.context.broadcast.onState(latest, next)
    })
    this.tails.set(record.sessionId, current)
    try {
      await current
    } finally {
      if (this.tails.get(record.sessionId) === current) this.tails.delete(record.sessionId)
    }
  }
}

async function sendAndWaitWithActivityTimeout(session: CopilotSession, message: MessageOptions) {
  let timeout: NodeJS.Timeout | undefined
  let rejectInactivity!: (error: Error) => void
  const inactivity = new Promise<never>((_, reject) => {
    rejectInactivity = reject
  })
  const armTimeout = () => {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      rejectInactivity(new Error(`Timeout after ${COPILOT_INACTIVITY_TIMEOUT_MS}ms without Copilot session activity`))
    }, COPILOT_INACTIVITY_TIMEOUT_MS)
    timeout.unref?.()
  }
  const unsubscribe = session.on(() => armTimeout())
  armTimeout()
  try {
    return await Promise.race([
      session.sendAndWait(message, COPILOT_SDK_TURN_TIMEOUT_MS),
      inactivity,
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    unsubscribe()
  }
}

function modelInfo(model: CopilotModelInfo): ModelInfo {
  return {
    ref: model.id,
    id: model.id,
    label: model.name,
    provider: 'GitHub Copilot',
    providerId: 'github-copilot',
    ...(model.capabilities.limits.max_context_window_tokens
      ? { contextWindow: model.capabilities.limits.max_context_window_tokens }
      : {}),
  }
}

function userMessage(input: AgentRuntimeSendInput): Message {
  if (input.content && input.content.length > 0) return { role: 'user', content: [...input.content] }
  return { role: 'user', content: [{ type: 'text', text: input.text }] }
}

async function copilotMessageOptions(
  context: AgentRuntimeContext,
  record: SessionRecord,
  input: AgentRuntimeSendInput,
): Promise<MessageOptions> {
  const attachments: NonNullable<MessageOptions['attachments']> = []
  for (const block of input.content ?? []) {
    if (block.type === 'file' && 'data' in block) {
      attachments.push({
        type: 'blob',
        data: block.data,
        mimeType: block.mediaType,
        displayName: block.name,
      })
    } else if (block.type === 'file') {
      if (!context.messageAttachments) {
        throw new Error(`Attachment "${block.name}" cannot be resolved because Host attachment storage is unavailable`)
      }
      const data = await context.messageAttachments.resolve(record.sessionId, block).read()
      attachments.push({
        type: 'blob',
        data: data.toString('base64'),
        mimeType: block.mediaType,
        displayName: block.name,
      })
    } else if (block.type === 'image' && block.source.kind === 'base64') {
      attachments.push({
        type: 'blob',
        data: block.source.data,
        mimeType: block.source.mediaType,
        displayName: `pasted-image.${imageExtension(block.source.mediaType)}`,
      })
    } else if (block.type === 'image' && block.source.kind === 'file_ref') {
      attachments.push({
        type: 'file',
        path: block.source.path,
        displayName: block.source.path.split(/[\\/]/u).at(-1) ?? block.source.path,
      })
    }
  }
  return {
    prompt: input.text,
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

function imageExtension(mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  return mediaType.slice('image/'.length)
}

function completeCompactionContextTokens(data: {
  systemTokens?: number
  conversationTokens?: number
  toolDefinitionsTokens?: number
}): number | undefined {
  if (
    data.systemTokens === undefined
    || data.conversationTokens === undefined
    || data.toolDefinitionsTokens === undefined
  ) return undefined
  return data.systemTokens + data.conversationTokens + data.toolDefinitionsTokens
}

function copilotContextSnapshot(
  record: SessionRecord,
  usage: {
    currentTokens: number
    tokenLimit: number
    systemTokens?: number
    conversationTokens?: number
    toolDefinitionsTokens?: number
  },
): ContextUsageSnapshot {
  const system = usage.systemTokens ?? 0
  const transcript = usage.conversationTokens ?? Math.max(0, usage.currentTokens - system - (usage.toolDefinitionsTokens ?? 0))
  const tools = usage.toolDefinitionsTokens ?? 0
  const model = record.preferences?.selectedModel ?? 'unknown'
  return {
    model: { ref: model, provider: 'github-copilot', id: model },
    contextWindow: { tokens: usage.tokenLimit, source: 'api_reported' },
    usage: { inputTokens: usage.currentTokens, totalTokens: usage.currentTokens },
    breakdown: {
      system,
      transcript,
      tools,
      memory: Math.max(0, usage.currentTokens - system - transcript - tools),
      attachments: 0,
      pendingUserInput: 0,
    },
    estimator: {
      total: { kind: 'provider_reported', confidence: 'exact' },
      breakdown: { kind: 'heuristic', confidence: 'estimated' },
      version: 'copilot-sdk-usage-info-v1',
    },
    updatedAt: Date.now(),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function requiresApproval(mode: ApprovalMode, toolRequiresApproval: boolean): boolean {
  if (mode === 'allow_all') return false
  if (mode === 'ask') return true
  if (mode === 'deny') return false
  return toolRequiresApproval
}

function copilotStartupFailureReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/could not (?:find|resolve).*@github\/copilot|copilot cli not found|path to copilot cli is required|\bENOENT\b/i.test(detail)) {
    return `Copilot CLI unavailable: ${detail} Install the complete @github/copilot-sdk npm dependencies or set COPILOT_CLI_PATH to a compatible Copilot CLI executable.`
  }
  return detail
}

function approvalKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`
}

function toolResult(ok: boolean, content: string, resultType: ToolResultObject['resultType']): ToolResultObject {
  return {
    textResultForLlm: content,
    resultType,
    ...(!ok ? { error: content } : {}),
  }
}

function nativeEventPayload(event: SessionEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
  }
}
