import { allTools, createSandbox, createToolRegistry } from '@agent-kernel/executor'

import type { CallToolEffect, ToolSchema } from '@agent-kernel/kernel'
import { createBuiltinTools } from '../builtin-tools.js'
import type { ToolDispatcher } from '../loop-types.js'

/**
 * In-process tool dispatcher for the RL smoke runner. Runs the executor's
 * built-in tools directly against a sandbox rooted at `workdir`. Only the
 * RL whitelist is exposed: read_file, read_files, write_file,
 * replace_in_file, replace_many_in_file, apply_file_patch, bash, ls, grep,
 * glob.
 */
export function inProcessRlToolDispatcher(workdir: string): ToolDispatcher {
  const sandbox = createSandbox({ roots: [workdir] })
  const registry = createToolRegistry(
    allTools.filter((tool) => RL_WHITELIST.has(tool.name)),
  )
  const controllers = new Map<string, AbortController>()
  return {
    async callTool(sessionId: string, eff: CallToolEffect) {
      const tool = registry.get(eff.name)
      if (!tool) return { ok: false, content: `ERROR: EUNKNOWN: tool not enabled for rl: ${eff.name}` }
      const controller = new AbortController()
      const key = `${sessionId}:${eff.callId}`
      controllers.set(key, controller)
      try {
        const content = await tool.run(eff.input, {
          sessionId,
          sandbox,
          signal: controller.signal,
          cwd: eff.cwd ?? workdir,
        })
        const ok = !content.startsWith('ERROR:')
        return { ok, content }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, content: `ERROR: EEXCEPTION: ${message}` }
      } finally {
        controllers.delete(key)
      }
    },
    cancelPending(sessionId: string) {
      for (const [key, controller] of controllers) {
        if (key.startsWith(`${sessionId}:`)) controller.abort()
      }
    },
  }
}

export const RL_WHITELIST = new Set<string>([
  'read_file',
  'read_files',
  'write_file',
  'replace_in_file',
  'replace_many_in_file',
  'apply_file_patch',
  'bash',
  'ls',
  'grep',
  'glob',
])

export function rlToolSchemas(): readonly ToolSchema[] {
  return createBuiltinTools().filter((schema) => RL_WHITELIST.has(schema.name))
}
