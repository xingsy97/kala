/**
 * Tool-result  -  state lift.
 *
 * A narrow set of tool results carry data that belongs in first-class kernel
 * state, not just in the transcript. The reducer looks inside `tool_result`
 * for exactly this tool:
 *
 *   - `memory`         with `operation === 'write' | 'delete'` and
 *                      `input.scope === 'session'`
 *                       -  upsert/remove `{ key, content, updatedAt }` in `state.memory`
 *
 * Everything else is opaque  -  the reducer never inspects tool call inputs
 * for any other name. Parsing happens from `pendingCall.input` (not from the
 * tool's `content` return value), so a broken or malicious executor cannot
 * corrupt kernel state via the tool result string.
 *
 * Workspace / global scope memory ops round-trip normally as opaque
 * tool_results  -  the executor writes to disk and the LLM gets a string ack.
 */

import type {
  MemoryEntry,
} from './types.js'
import { MEMORY_TOOL_NAME } from './types.js'

// ============================================================================
// memory (session scope only; workspace/global stay on-disk in the executor)
// ============================================================================

/**
 * Detect a session-scope memory op. Only these round-trip through the kernel;
 * workspace/global memory ops touch disk on the executor and produce a normal
 * (opaque) tool_result string with no state promotion here.
 */
export function isSessionMemoryOp(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName !== MEMORY_TOOL_NAME) return false
  if ((input as { scope?: unknown }).scope !== 'session') return false
  return memoryWriteOrDeleteOperation(input) !== null
}

/**
 * Apply an in-kernel session memory op. Keys are unique per session; upsert
 * (write) replaces any prior entry with the same key. `updatedAt` comes from
 * the tool input if present, otherwise omitted  -  the reducer stays pure and
 * refuses to touch a clock.
 */
export function applyMemoryOp(
  current: readonly MemoryEntry[],
  toolName: string,
  input: Record<string, unknown>,
): readonly MemoryEntry[] {
  const key = (input as { key?: unknown }).key
  if (typeof key !== 'string' || key.length === 0) return current
  const operation = toolName === MEMORY_TOOL_NAME
    ? memoryWriteOrDeleteOperation(input)
    : null
  if (operation === 'delete') {
    return current.filter((m) => m.key !== key)
  }
  if (operation !== 'write') return current
  const content = (input as { content?: unknown }).content
  if (typeof content !== 'string') return current
  const updatedAt = (input as { updatedAt?: unknown }).updatedAt
  const stamped =
    typeof updatedAt === 'string' && updatedAt.length > 0
      ? updatedAt
      : '1970-01-01T00:00:00.000Z' // reducer stays pure; host stamps real time via tool input
  const entry: MemoryEntry = { key, content, updatedAt: stamped }
  const existing = current.findIndex((m) => m.key === key)
  if (existing === -1) return [...current, entry]
  const next = current.slice()
  next[existing] = entry
  return next
}

function memoryWriteOrDeleteOperation(
  input: Record<string, unknown>,
): 'write' | 'delete' | null {
  const operation = (input as { operation?: unknown }).operation
  return operation === 'write' || operation === 'delete' ? operation : null
}
