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
  type ModelInfo,
} from '@agent-kernel/shared'
import {
  CopilotClient,
  RuntimeConnection,
  type ModelInfo as CopilotModelInfo,
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
  private readonly tails = new Map<string, Promise<void>>()
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
      this.client = new CopilotClient({
        mode: 'empty',
        connection: RuntimeConnection.forStdio({ args: ['--no-remote-export'] }),
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
      this.reason = error instanceof Error ? error.message : String(error)
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
    void this.runTurn(record, session, input.text)
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
    return session
  }

  private sessionConfig(record: SessionRecord, model?: string) {
    const tools = record.config.tools.map((schema) => this.tool(record, schema))
    return {
      clientName: 'agent-runlab',
      ...(model ? { model } : {}),
      // The Copilot CLI runs with the Host, while record.state.cwd belongs to
      // the remote Workspace Executor. Keep the SDK in Host-owned storage and
      // pass the workspace cwd only through RunLab custom Tool dispatch.
      workingDirectory: this.options.sessionsDir,
      systemMessage: {
        mode: 'replace' as const,
        content: record.config.systemPrompt ?? 'You are an AI coding agent.',
      },
      tools,
      availableTools: tools.map((tool) => `custom:${tool.name}`),
      excludedTools: ['builtin:*', 'mcp:*'],
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      remoteSession: 'off' as const,
      coauthorEnabled: false,
      enableExperimentalMode: false,
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
    if (event.type === 'assistant.message_delta') {
      this.context.broadcast.onTokenDelta(record.sessionId, event.data.deltaContent)
      return
    }
    if (event.type === 'assistant.message' || event.type === 'session.idle') return
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

  private async runTurn(record: SessionRecord, session: CopilotSession, prompt: string): Promise<void> {
    try {
      const response = await sendAndWaitWithActivityTimeout(session, prompt)
      if (this.cancelledSessions.delete(record.sessionId)) return
      const pendingProjection = this.tails.get(record.sessionId)
      if (pendingProjection) await pendingProjection
      if (!response) throw new Error('Copilot turn completed without an assistant message')
      const content: MessageContent[] = []
      if (response.data.reasoningText) {
        content.push({ type: 'thinking', text: response.data.reasoningText, provider: 'github-copilot' })
      }
      if (response.data.content) content.push({ type: 'text', text: response.data.content })
      if (content.length === 0) throw new Error('Copilot assistant message was empty')
      await this.project(record, 'copilot.assistant_message', nativeEventPayload(response), (state) => ({
        ...state,
        messages: [...state.messages, { role: 'assistant', content }],
        status: 'thinking',
        pendingCalls: [],
        error: undefined,
      }))
      await this.project(record, 'copilot.session_idle', nativeEventPayload(response), (state) => ({
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
    }
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

  private async project(
    record: SessionRecord,
    action: string,
    payload: Record<string, unknown>,
    update: (state: AgentState) => Omit<AgentState, 'cursor'>,
  ): Promise<void> {
    const previous = this.tails.get(record.sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const latest = this.context.store.get(record.sessionId) ?? record
      const next = { ...update(latest.state), cursor: latest.state.cursor + 1 } as AgentState
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

async function sendAndWaitWithActivityTimeout(session: CopilotSession, prompt: string) {
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
      session.sendAndWait({ prompt }, COPILOT_SDK_TURN_TIMEOUT_MS),
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
