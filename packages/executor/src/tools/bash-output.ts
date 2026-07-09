import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { optionalBoolean, optionalPositiveInt, requireString } from './schema.js'
import { readBackgroundShell } from './background-shell.js'

export const bashOutputTool: Tool = {
  name: 'bash_output',
  async run(input) {
    const taskId = requireString(input, 'task_id')
    const offset = optionalPositiveInt(input, 'offset', 0) ?? 0
    const block = optionalBoolean(input, 'block') ?? false
    const timeoutMs = optionalPositiveInt(input, 'timeout_ms', 1) ?? 30_000
    try {
      const out = await readBackgroundShell({ taskId, offset, block, timeoutMs })
      return JSON.stringify(out)
    } catch (err) {
      throw new ToolError(
        'EINVAL',
        err instanceof Error ? err.message : String(err),
      )
    }
  },
}
