import type { Tool } from './registry.js'
import { ToolError } from './registry.js'
import { requireString } from './schema.js'
import { killBackgroundShell } from './background-shell.js'

export const killShellTool: Tool = {
  name: 'kill_shell',
  async run(input, ctx) {
    const taskId = requireString(input, 'task_id')
    try {
      const killed = await killBackgroundShell(taskId, ctx.sessionId)
      return JSON.stringify({ taskId, killed })
    } catch (err) {
      throw new ToolError(
        'EINVAL',
        err instanceof Error ? err.message : String(err),
      )
    }
  },
}
