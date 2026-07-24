import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'

/**
 * View-model item emitted after grouping. A "group" represents one or more
 * consecutive tool_call blocks inside one assistant message.content, and hides
 * tool_result blocks that belong to grouped calls.
 *
 * Multi-call runs become one activity block; the UI then summarizes lifecycle,
 * tool mix, and per-call detail without changing the protocol transcript.
 */
export type ToolCallGroup = {
  kind: 'tool_call_group'
  toolName: string
  mixed: boolean
  calls: ToolCallContent[]
  results: Map<string, ToolResultContent>
  firstCallId: string
}

export type GroupedContentItem =
  | { kind: 'single'; content: MessageContent }
  | ToolCallGroup

export function groupConsecutiveToolCalls(
  content: readonly MessageContent[],
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
): GroupedContentItem[] {
  const out: GroupedContentItem[] = []
  let i = 0
  while (i < content.length) {
    const c = content[i]!
    if (c.type !== 'tool_call') {
      out.push({ kind: 'single', content: c })
      i += 1
      continue
    }
    let j = i + 1
    while (j < content.length && content[j]!.type === 'tool_call') {
      j += 1
    }
    const run = content.slice(i, j) as ToolCallContent[]

    if (run.length > 1) {
      out.push(makeToolCallGroup(run, resultsByCallId, true))
    } else {
      out.push(makeToolCallGroup(run, resultsByCallId, false))
    }
    i = j
  }
  return out
}

export function makeToolCallGroup(
  calls: ToolCallContent[],
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
  mixed: boolean,
): ToolCallGroup {
  const results = new Map<string, ToolResultContent>()
  for (const call of calls) {
    const r = resultsByCallId.get(call.callId)
    if (r) results.set(call.callId, r)
  }
  return {
    kind: 'tool_call_group',
    toolName: mixed ? 'tool activity' : calls[0]!.name,
    mixed,
    calls,
    results,
    firstCallId: calls[0]!.callId,
  }
}

export function collectAllToolResults(
  messages: readonly Message[],
): Map<string, ToolResultContent> {
  const map = new Map<string, ToolResultContent>()
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === 'tool_result') map.set(c.callId, c)
    }
  }
  return map
}

export function collectGroupedResultCallIds(
  messages: readonly Message[],
): Set<string> {
  const results = collectAllToolResults(messages)
  const grouped = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    const items = groupConsecutiveToolCalls(m.content, results)
    for (const item of items) {
      if (item.kind === 'tool_call_group') {
        for (const c of item.calls) grouped.add(c.callId)
      }
    }
  }
  return grouped
}
