/**
 * Tool registry: a `name → runner` map. Each runner is `(input, ctx) → string`.
 *
 * Runners must throw only for programmer errors; expected user errors
 * (ENOENT, EACCES, etc.) are returned as a string prefixed with `ERROR: <code>:`
 * and surfaced via `{ ok: false, content }` at the client boundary.
 */

import type { Sandbox } from '../sandbox.js'

export type ToolContext = {
  readonly sandbox: Sandbox
  readonly signal: AbortSignal
}

export type ToolRunner = (
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string>

export type Tool = {
  readonly name: string
  readonly run: ToolRunner
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'ToolError'
  }
}

/**
 * Guard for cooperative cancellation. Tools that perform multiple awaits
 * (read → decide → write) MUST call this at each yield point so `cancel`
 * events from the kernel actually prevent side effects rather than being
 * silently ignored.
 */
export function throwIfAborted(ctx: ToolContext): void {
  if (ctx.signal.aborted) {
    throw new ToolError('ECANCELED', 'operation aborted by caller')
  }
}

export function createToolRegistry(tools: readonly Tool[]): Map<string, Tool> {
  const map = new Map<string, Tool>()
  for (const t of tools) {
    if (map.has(t.name)) {
      throw new Error(`duplicate tool: ${t.name}`)
    }
    map.set(t.name, t)
  }
  return map
}
