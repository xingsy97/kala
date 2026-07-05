import type { ToolCallContent } from '@agent-kernel/kernel'

import type { TimelineEntry } from './session.js'

export type BackgroundTerminalTask = {
  taskId: string
  callId: string
  command: string
  cwd?: string
  status: 'running' | 'done' | 'killed' | 'unknown'
  output: string
  nextOffset?: number
}

export function backgroundTerminalTasks(
  timeline: readonly TimelineEntry[],
): readonly BackgroundTerminalTask[] {
  const calls = new Map<string, ToolCallContent>()
  const taskById = new Map<string, BackgroundTerminalTask>()

  for (const entry of timeline) {
    if (entry.event.kind === 'llm_response') {
      for (const content of entry.event.message.content) {
        if (content.type === 'tool_call') calls.set(content.callId, content)
      }
      continue
    }

    if (entry.event.kind !== 'tool_result') continue
    const call = calls.get(entry.event.callId)
    if (!call) continue

    if (call.name === 'bash' && call.input.run_in_background === true) {
      const parsed = parseJsonObject(entry.event.content)
      const taskId = typeof parsed?.taskId === 'string' ? parsed.taskId : null
      if (!taskId) continue
      taskById.set(taskId, {
        taskId,
        callId: call.callId,
        command: typeof call.input.command === 'string' ? call.input.command : '(unknown command)',
        ...(typeof call.input.cwd === 'string' ? { cwd: call.input.cwd } : {}),
        status: 'running',
        output: '',
      })
      continue
    }

    if (call.name === 'bash_output') {
      const taskId = typeof call.input.task_id === 'string' ? call.input.task_id : null
      if (!taskId) continue
      const task = taskById.get(taskId)
      if (!task) continue
      const parsed = parseJsonObject(entry.event.content)
      if (typeof parsed?.content === 'string') task.output += parsed.content
      if (typeof parsed?.nextOffset === 'number') task.nextOffset = parsed.nextOffset
      if (parsed?.done === true) task.status = 'done'
      continue
    }

    if (call.name === 'kill_shell') {
      const taskId = typeof call.input.task_id === 'string' ? call.input.task_id : null
      if (!taskId) continue
      const task = taskById.get(taskId)
      if (!task) continue
      const parsed = parseJsonObject(entry.event.content)
      if (parsed?.killed === true) task.status = 'killed'
    }
  }

  return [...taskById.values()]
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}
