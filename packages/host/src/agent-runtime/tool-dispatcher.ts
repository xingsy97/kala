import type { HostLoopDeps, LoopHandle, ToolDispatcher } from '../loop-types.js'
import { dispatchRuntimeTool } from '../loop.js'

export function createRuntimeToolDispatcher(
  deps: HostLoopDeps,
  executors: ToolDispatcher,
  loop: LoopHandle,
): ToolDispatcher {
  const aborts = new Map<string, AbortController>()
  const callsBySession = new Map<string, Set<string>>()

  return {
    async callTool(sessionId, effect, turnId) {
      let calls = callsBySession.get(sessionId)
      if (!calls) {
        calls = new Set()
        callsBySession.set(sessionId, calls)
      }
      calls.add(effect.callId)
      try {
        return await dispatchRuntimeTool(deps, sessionId, effect, aborts, turnId, loop)
      } finally {
        calls.delete(effect.callId)
        if (calls.size === 0) callsBySession.delete(sessionId)
      }
    },
    cancelPending(sessionId) {
      executors.cancelPending(sessionId)
      for (const callId of callsBySession.get(sessionId) ?? []) {
        aborts.get(callId)?.abort()
      }
    },
  }
}
