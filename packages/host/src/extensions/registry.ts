import type { AgentConfig, AgentEvent, CallLlmEffect, CallToolEffect, Message } from '@agent-kernel/kernel'

import type { ToolExecutionResult } from '../agent-modules/execution.js'
import type { CompactRequest, HostLoopDeps, LoopHandle } from '../loop-types.js'
import type { SessionRecord } from '../store/session.js'
import type { SubAgentRuntimeController } from './agent-tool.js'
import type { ConsolidationOutcome } from './memory-consolidation.js'

export type HostToolContext = {
  deps: HostLoopDeps
  sessionId: string
  effect: CallToolEffect
  aborts: Map<string, AbortController>
  turnId?: string
  loop?: LoopHandle
  plannedContinuation: boolean
  runtimeController?: SubAgentRuntimeController
}

export type SessionLifecycleContext = {
  deps: HostLoopDeps
  record: SessionRecord
}

export type TurnLifecycleContext = {
  deps: HostLoopDeps
  sessionId: string
  event: AgentEvent
  loop: LoopHandle
  autoCompact(): Promise<void>
  resumeDurableWork(): Promise<void>
}

export type StateTransitionLifecycleContext = {
  deps: HostLoopDeps
  record: SessionRecord
  event: AgentEvent
}

export type ModelLifecycleContext = {
  deps: HostLoopDeps
  sessionId: string
  config: AgentConfig
  effect: CallLlmEffect
  model?: string
  messages: readonly Message[]
  requiresCompaction: boolean
  compact(): Promise<boolean>
  messagesAfterCompaction(): readonly Message[]
}

export type ModelCallResult = Awaited<ReturnType<HostLoopDeps['llm']['call']>>

export type CancellationLifecycleContext = {
  deps: HostLoopDeps
  sessionId: string
  aborts: Map<string, AbortController>
}

export type RecoveryLifecycleContext = {
  deps: HostLoopDeps
  sessionId: string
  loop: LoopHandle
}

export type SessionModeContribution = {
  id: string
  label: string
  description: string
}

export type RuntimeMaintenance = {
  compact?(
    deps: HostLoopDeps,
    sessionId: string,
    request: CompactRequest,
    inFlight: Set<string>,
    aborts: Map<string, AbortController>,
  ): Promise<boolean>
  consolidateMemory?(deps: HostLoopDeps, sessionId: string): Promise<ConsolidationOutcome>
}

export type ExtensionLifecycle = {
  onSessionCreated?(context: SessionLifecycleContext): Promise<void> | void
  onSessionLoaded?(context: SessionLifecycleContext): Promise<void> | void
  onSessionDeleted?(context: SessionLifecycleContext): Promise<void> | void
  beforeStateTransition?(context: StateTransitionLifecycleContext): Promise<void> | void
  beforeTurn?(context: TurnLifecycleContext): Promise<void> | void
  afterTurn?(context: TurnLifecycleContext): Promise<void> | void
  beforeModelCall?(context: ModelLifecycleContext): Promise<readonly Message[] | void> | readonly Message[] | void
  afterModelCall?(context: ModelLifecycleContext, result: ModelCallResult): Promise<void> | void
  beforeToolDispatch?(context: HostToolContext): Promise<ToolExecutionResult | null> | ToolExecutionResult | null
  afterToolDispatch?(context: HostToolContext, result: ToolExecutionResult): Promise<void> | void
  onCancel?(context: CancellationLifecycleContext): Promise<void> | void
  recoverSession?(context: RecoveryLifecycleContext): Promise<boolean> | boolean
}

export type HostToolHandler = (context: HostToolContext) => Promise<ToolExecutionResult>

export type HostExtension = {
  id: string
  version: string
  toolHandlers?: Readonly<Record<string, HostToolHandler>>
  sessionModes?: readonly SessionModeContribution[]
  maintenance?: RuntimeMaintenance
  lifecycle?: ExtensionLifecycle
}

export type ExtensionRegistry = {
  register(extension: HostExtension): void
  seal(): void
  list(): readonly HostExtension[]
  listSessionModes(): readonly SessionModeContribution[]
  getSessionMode(id: string): SessionModeContribution | undefined
  getToolHandler(name: string): HostToolHandler | undefined
  dispatchHostTool(name: string, context: HostToolContext): Promise<ToolExecutionResult>
  sessionCreated(context: SessionLifecycleContext): Promise<void>
  sessionLoaded(context: SessionLifecycleContext): Promise<void>
  sessionDeleted(context: SessionLifecycleContext): Promise<void>
  beforeStateTransition(context: StateTransitionLifecycleContext): Promise<void>
  beforeTurn(context: TurnLifecycleContext): Promise<void>
  afterTurn(context: TurnLifecycleContext): Promise<void>
  beforeModelCall(context: ModelLifecycleContext): Promise<readonly Message[]>
  afterModelCall(context: ModelLifecycleContext, result: ModelCallResult): Promise<void>
  beforeToolDispatch(context: HostToolContext): Promise<ToolExecutionResult | null>
  afterToolDispatch(context: HostToolContext, result: ToolExecutionResult): Promise<void>
  cancel(context: CancellationLifecycleContext): Promise<void>
  recoverSession(context: RecoveryLifecycleContext): Promise<boolean>
  compact(
    deps: HostLoopDeps,
    sessionId: string,
    request: CompactRequest,
    inFlight: Set<string>,
    aborts: Map<string, AbortController>,
  ): Promise<boolean>
  consolidateMemory(deps: HostLoopDeps, sessionId: string): Promise<ConsolidationOutcome>
}

export function createExtensionRegistry(initial: readonly HostExtension[] = []): ExtensionRegistry {
  const extensions: HostExtension[] = []
  const extensionIds = new Set<string>()
  const handlers = new Map<string, HostToolHandler>()
  const sessionModes = new Map<string, SessionModeContribution>()
  let compactor: RuntimeMaintenance['compact']
  let memoryConsolidator: RuntimeMaintenance['consolidateMemory']
  let sealed = false

  const registry: ExtensionRegistry = {
    register(extension) {
      if (sealed) throw new Error('extension registry is sealed')
      if (!extension.id.trim()) throw new Error('extension id is required')
      if (extensionIds.has(extension.id)) throw new Error(`duplicate extension id: ${extension.id}`)
      for (const [name, handler] of Object.entries(extension.toolHandlers ?? {})) {
        if (handlers.has(name)) throw new Error(`duplicate host tool handler: ${name}`)
        if (typeof handler !== 'function') throw new Error(`invalid host tool handler: ${name}`)
      }
      for (const mode of extension.sessionModes ?? []) {
        if (!mode.id.trim()) throw new Error('session mode id is required')
        if (sessionModes.has(mode.id)) throw new Error(`duplicate session mode: ${mode.id}`)
      }
      if (extension.maintenance?.consolidateMemory && memoryConsolidator) {
        throw new Error('duplicate memory consolidation contribution')
      }
      if (extension.maintenance?.compact && compactor) {
        throw new Error('duplicate compaction contribution')
      }
      extensionIds.add(extension.id)
      extensions.push(extension)
      for (const [name, handler] of Object.entries(extension.toolHandlers ?? {})) handlers.set(name, handler)
      for (const mode of extension.sessionModes ?? []) sessionModes.set(mode.id, Object.freeze({ ...mode }))
      if (extension.maintenance?.compact) compactor = extension.maintenance.compact
      if (extension.maintenance?.consolidateMemory) memoryConsolidator = extension.maintenance.consolidateMemory
    },
    seal() {
      sealed = true
    },
    list() {
      return Object.freeze([...extensions])
    },
    listSessionModes() {
      return Object.freeze([...sessionModes.values()])
    },
    getSessionMode(id) {
      return sessionModes.get(id)
    },
    getToolHandler(name) {
      return handlers.get(name)
    },
    async dispatchHostTool(name, context) {
      const handler = handlers.get(name)
      if (!handler) return { ok: false, content: `host tool handler is not registered: ${name}` }
      return await handler(context)
    },
    async sessionCreated(context) {
      for (const extension of extensions) await extension.lifecycle?.onSessionCreated?.(context)
    },
    async sessionLoaded(context) {
      for (const extension of extensions) await extension.lifecycle?.onSessionLoaded?.(context)
    },
    async sessionDeleted(context) {
      for (const extension of extensions) await extension.lifecycle?.onSessionDeleted?.(context)
    },
    async beforeStateTransition(context) {
      for (const extension of extensions) await extension.lifecycle?.beforeStateTransition?.(context)
    },
    async beforeTurn(context) {
      for (const extension of extensions) await extension.lifecycle?.beforeTurn?.(context)
    },
    async afterTurn(context) {
      for (const extension of extensions) await extension.lifecycle?.afterTurn?.(context)
    },
    async beforeModelCall(context) {
      let messages = context.messages
      for (const extension of extensions) {
        const next = await extension.lifecycle?.beforeModelCall?.({ ...context, messages })
        if (next) messages = next
      }
      return messages
    },
    async afterModelCall(context, result) {
      for (const extension of extensions) await extension.lifecycle?.afterModelCall?.(context, result)
    },
    async beforeToolDispatch(context) {
      for (const extension of extensions) {
        const blocked = await extension.lifecycle?.beforeToolDispatch?.(context)
        if (blocked) return blocked
      }
      return null
    },
    async afterToolDispatch(context, result) {
      for (const extension of extensions) await extension.lifecycle?.afterToolDispatch?.(context, result)
    },
    async cancel(context) {
      for (const extension of extensions) await extension.lifecycle?.onCancel?.(context)
    },
    async recoverSession(context) {
      let recovered = false
      for (const extension of extensions) {
        recovered = await extension.lifecycle?.recoverSession?.(context) || recovered
      }
      return recovered
    },
    async compact(deps, sessionId, request, inFlight, aborts) {
      if (!compactor) return false
      return await compactor(deps, sessionId, request, inFlight, aborts)
    },
    async consolidateMemory(deps, sessionId) {
      if (!memoryConsolidator) {
        return { saved: [], skipped: 0, error: 'memory consolidation extension is not registered' }
      }
      return await memoryConsolidator(deps, sessionId)
    },
  }
  for (const extension of initial) registry.register(extension)
  return registry
}
