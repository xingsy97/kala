import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'

/**
 * View-model item emitted after grouping. A "group" collapses  - 2 consecutive
 * tool_call blocks (same tool name) inside one assistant message.content, and
 * hides tool_result blocks that all belong to already-grouped calls.
 */
export type ToolCallGroup = {
  kind: 'tool_call_group'
  toolName: string
  calls: ToolCallContent[]
  results: Map<string, ToolResultContent>
  firstCallId: string
}

export type GroupedContentItem =
  | { kind: 'single'; content: MessageContent }
  | ToolCallGroup

const MIN_GROUP_SIZE = 2

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
    while (
      j < content.length &&
      content[j]!.type === 'tool_call' &&
      (content[j] as ToolCallContent).name === c.name
    ) {
      j += 1
    }
    const run = content.slice(i, j) as ToolCallContent[]
    if (run.length >= MIN_GROUP_SIZE) {
      const results = new Map<string, ToolResultContent>()
      for (const call of run) {
        const r = resultsByCallId.get(call.callId)
        if (r) results.set(call.callId, r)
      }
      out.push({
        kind: 'tool_call_group',
        toolName: c.name,
        calls: run,
        results,
        firstCallId: run[0]!.callId,
      })
    } else {
      for (const call of run) out.push({ kind: 'single', content: call })
    }
    i = j
  }
  return out
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
