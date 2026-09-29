import type { CallToolEffect } from '@agent-kernel/kernel'

import type { ToolExecutionResult } from '../agent-modules/execution.js'
import type { HostLoopDeps, LoopHandle } from '../loop-types.js'
import type { SubAgentRuntimeController } from './agent-tool.js'

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

export type ExtensionLifecycle = {
  beforeToolDispatch?(context: HostToolContext): Promise<ToolExecutionResult | null> | ToolExecutionResult | null
  afterToolDispatch?(context: HostToolContext, result: ToolExecutionResult): Promise<void> | void
}

export type HostToolHandler = (context: HostToolContext) => Promise<ToolExecutionResult>

export type HostExtension = {
  id: string
  version: string
  toolHandlers?: Readonly<Record<string, HostToolHandler>>
  lifecycle?: ExtensionLifecycle
}

export type ExtensionRegistry = {
  register(extension: HostExtension): void
  seal(): void
  list(): readonly HostExtension[]
  getToolHandler(name: string): HostToolHandler | undefined
  dispatchHostTool(name: string, context: HostToolContext): Promise<ToolExecutionResult>
  beforeToolDispatch(context: HostToolContext): Promise<ToolExecutionResult | null>
  afterToolDispatch(context: HostToolContext, result: ToolExecutionResult): Promise<void>
}

export function createExtensionRegistry(initial: readonly HostExtension[] = []): ExtensionRegistry {
  const extensions: HostExtension[] = []
  const extensionIds = new Set<string>()
  const handlers = new Map<string, HostToolHandler>()
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
      extensionIds.add(extension.id)
      extensions.push(extension)
      for (const [name, handler] of Object.entries(extension.toolHandlers ?? {})) handlers.set(name, handler)
    },
    seal() {
      sealed = true
    },
    list() {
      return Object.freeze([...extensions])
    },
    getToolHandler(name) {
      return handlers.get(name)
    },
    async dispatchHostTool(name, context) {
      const handler = handlers.get(name)
      if (!handler) return { ok: false, content: `host tool handler is not registered: ${name}` }
      return await handler(context)
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
  }
  for (const extension of initial) registry.register(extension)
  return registry
}
