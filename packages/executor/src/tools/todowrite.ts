import type { Tool } from './registry.js'
import { ToolError } from './registry.js'

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
const PRIORITIES = new Set(['high', 'medium', 'low'])

/**
 * `todowrite` is unusual: the executor doesn't do any IO. The real "effect"
 * is that the kernel reducer intercepts the tool_result for this tool name
 * and promotes `input.todos` onto `state.todos`. This runner exists so the
 * tool call still round-trips through the normal executor path (matching
 * every other builtin), and to validate the shape server-side rather than
 * trusting the LLM's JSON.
 */
export const todowriteTool: Tool = {
  name: 'todowrite',
  async run(input) {
    const todos = (input as { todos?: unknown }).todos
    if (!Array.isArray(todos)) {
      throw new ToolError('EINVAL', 'missing or non-array field "todos"')
    }
    let inProgress = 0
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i]
      if (!t || typeof t !== 'object') {
        throw new ToolError('EINVAL', `todos[${i}] must be an object`)
      }
      const rec = t as Record<string, unknown>
      if (typeof rec.content !== 'string' || rec.content.length === 0) {
        throw new ToolError('EINVAL', `todos[${i}].content must be a non-empty string`)
      }
      if (typeof rec.status !== 'string' || !STATUSES.has(rec.status)) {
        throw new ToolError(
          'EINVAL',
          `todos[${i}].status must be one of pending|in_progress|completed|cancelled`,
        )
      }
      if (rec.status === 'in_progress') inProgress++
      if (rec.priority !== undefined) {
        if (typeof rec.priority !== 'string' || !PRIORITIES.has(rec.priority)) {
          throw new ToolError(
            'EINVAL',
            `todos[${i}].priority must be one of high|medium|low`,
          )
        }
      }
    }
    if (inProgress > 1) {
      throw new ToolError(
        'EINVAL',
        `at most one todo may be in_progress at a time (got ${inProgress})`,
      )
    }
    return `todos updated: ${todos.length} item${todos.length === 1 ? '' : 's'}`
  },
}
