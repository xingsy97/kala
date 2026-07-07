import type { Tool } from './registry.js'
import { ToolError } from './registry.js'

const STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
const PRIORITIES = new Set(['high', 'medium', 'low'])

/**
 * `todowrite` validates a complete replacement task list and returns a short
 * ack. It is ordinary tool protocol: the kernel records call_tool/tool_result,
 * and dashboard task UI derives its display from the event/effect trace.
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
