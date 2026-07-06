/**
 * Pre-/post-tool-use hook execution.
 *
 * Users configure external commands to fire around every tool call via
 * `~/.config/agent-kernel/config.toml` (see `hooks.ts` for the runner). This
 * module is the loop-side glue: pick the matching hooks for the current
 * event, spawn them, and turn a non-zero pre_tool_use exit into a synthetic
 * failure that blocks the actual tool dispatch.
 */

import type { CallToolEffect } from '@agent-kernel/kernel'

import { selectHooks } from './hooks.js'
import type { HostLoopDeps } from './loop.js'

/**
 * Run every configured pre_tool_use hook. Returns null when the tool call
 * may proceed, or a rejection string when a hook exited non-zero (the loop
 * uses it as the synthetic tool_result body).
 */
export async function runPreToolHooks(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
): Promise<string | null> {
  const hooks = deps.hooks
  const runner = deps.hookRunner
  if (!hooks || !runner || hooks.length === 0) return null
  const matching = selectHooks(hooks, 'pre_tool_use', effect.name)
  if (matching.length === 0) return null
  const record = deps.store.get(sessionId)
  for (const hook of matching) {
    const outcome = await runner.run(hook, {
      event: 'pre_tool_use',
      sessionId,
      ...(record?.workspaceId !== undefined
        ? { workspaceId: record.workspaceId }
        : {}),
      toolName: effect.name,
      toolInput: effect.input,
    })
    if (!outcome.ok) {
      const detail = (outcome.stdout || outcome.stderr).trim()
      return detail.length > 0
        ? `blocked by pre_tool_use hook (exit ${outcome.exitCode}): ${detail}`
        : `blocked by pre_tool_use hook (exit ${outcome.exitCode})`
    }
  }
  return null
}

/**
 * Run every configured post_tool_use hook. Post-hooks are advisory  -  their
 * exit code is not consumed by the loop.
 */
export async function runPostToolHooks(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  result: { ok: boolean; content: string },
): Promise<void> {
  const hooks = deps.hooks
  const runner = deps.hookRunner
  if (!hooks || !runner || hooks.length === 0) return
  const matching = selectHooks(hooks, 'post_tool_use', effect.name)
  if (matching.length === 0) return
  const record = deps.store.get(sessionId)
  for (const hook of matching) {
    await runner.run(hook, {
      event: 'post_tool_use',
      sessionId,
      ...(record?.workspaceId !== undefined
        ? { workspaceId: record.workspaceId }
        : {}),
      toolName: effect.name,
      toolInput: effect.input,
      toolResult: { ok: result.ok, content: result.content },
    })
  }
}
