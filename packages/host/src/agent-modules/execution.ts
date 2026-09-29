import type { CallToolEffect } from '@agent-kernel/kernel'

import type { SubAgentRuntimeController } from '../extensions/agent-tool.js'
import { createBuiltinExtensionRegistry } from '../extensions/builtin-registry.js'
import type { HostLoopDeps, LoopHandle } from '../loop-types.js'

export type ToolExecutionResult = {
  ok: boolean
  content: string
  failure?: import('@agent-kernel/kernel').ToolFailure
  durationMs?: number
}

export async function dispatchConfiguredTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  aborts: Map<string, AbortController>,
  turnId?: string,
  loop?: LoopHandle,
  plannedContinuation = false,
  runtimeController?: SubAgentRuntimeController,
): Promise<ToolExecutionResult> {
  const record = deps.store.get(sessionId)
  const schema = record?.config.tools.find((tool) => tool.name === effect.name)
  // Historical sessions may persist websearch as an executor tool. Its
  // model-facing name is the compatibility boundary after the Host migration.
  const executionKind = effect.name === 'websearch' ? 'host' : (schema?.executionKind ?? 'executor')
  if (executionKind === 'executor') {
    const handler = schema?.executionHandler ?? effect.name
    const call = plannedContinuation && deps.tools.callToolWhenAvailable
      ? deps.tools.callToolWhenAvailable.bind(deps.tools)
      : deps.tools.callTool.bind(deps.tools)
    return await call(sessionId, handler === effect.name ? effect : { ...effect, name: handler }, turnId)
  }

  const handler = effect.name === 'websearch' ? 'websearch' : (schema?.executionHandler ?? effect.name)
  const extensions = deps.extensions ?? createBuiltinExtensionRegistry()
  return await extensions.dispatchHostTool(handler, {
    deps,
    sessionId,
    effect,
    aborts,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(loop !== undefined ? { loop } : {}),
    plannedContinuation,
    ...(runtimeController !== undefined ? { runtimeController } : {}),
  })
}
