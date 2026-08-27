import type { MessageContent } from '@agent-kernel/kernel'
import type { TranscriptItem } from '../../transcript.js'

export type TranscriptSearchCategory = 'all' | 'user' | 'assistant' | 'thinking' | 'tools'

export type TranscriptSearchMatch = {
  anchor: string
  rawItemIndex: number
  messageIndex: number
  category: Exclude<TranscriptSearchCategory, 'all'>
  text: string
  start: number
  end: number
}

type SearchPart = { category: Exclude<TranscriptSearchCategory, 'all'>; text: string }

export function searchTranscript(
  items: readonly TranscriptItem[],
  query: string,
  category: TranscriptSearchCategory = 'all',
): readonly TranscriptSearchMatch[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const matches: TranscriptSearchMatch[] = []
  let messageIndex = -1
  for (let rawItemIndex = 0; rawItemIndex < items.length; rawItemIndex += 1) {
    const item = items[rawItemIndex]!
    if (item.kind === 'message') messageIndex += 1
    const anchor = item.kind === 'message'
      ? item.seq !== undefined ? `seq:${item.seq}` : item.streaming ? 'streaming-assistant' : `message:${rawItemIndex}`
      : item.kind === 'pending_user_message'
        ? `pending:${item.id}`
        : item.kind === 'model_changed'
          ? `model-changed:${rawItemIndex}`
          : `compact:${item.seq}`
    for (const part of searchableParts(item)) {
      if (category !== 'all' && part.category !== category) continue
      const haystack = part.text.toLocaleLowerCase()
      let from = 0
      while (from <= haystack.length - needle.length) {
        const start = haystack.indexOf(needle, from)
        if (start < 0) break
        matches.push({ anchor, rawItemIndex, messageIndex, category: part.category, text: part.text, start, end: start + needle.length })
        from = start + Math.max(1, needle.length)
      }
    }
  }
  return matches
}

export function nextSearchMatchIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}

export function searchMatchSnippet(match: TranscriptSearchMatch, radius = 42): string {
  const start = Math.max(0, match.start - radius)
  const end = Math.min(match.text.length, match.end + radius)
  return `${start > 0 ? '…' : ''}${match.text.slice(start, end).replace(/\s+/gu, ' ')}${end < match.text.length ? '…' : ''}`
}

function searchableParts(item: TranscriptItem): SearchPart[] {
  if (item.kind === 'compact_boundary') return item.summary ? [{ category: 'assistant', text: item.summary }] : []
  if (item.kind === 'pending_user_message') return [{ category: 'user', text: item.text }]
  if (item.kind === 'model_changed') {
    return [{ category: 'assistant', text: `Model changed${item.from ? `: ${item.from} → ${item.to}` : ` to ${item.to}`}` }]
  }
  const role = item.message.role
  const parts: SearchPart[] = []
  for (const content of item.message.content) {
    const part = searchableContent(content, role)
    if (part) parts.push(part)
  }
  return parts
}

function searchableContent(content: MessageContent, role: string): SearchPart | null {
  if (content.type === 'text') return { category: role === 'user' ? 'user' : 'assistant', text: content.text }
  if (content.type === 'thinking') return { category: 'thinking', text: content.text }
  if (content.type === 'tool_call') {
    return { category: 'tools', text: [content.name, content.intent, stableStringify(content.input)].filter(Boolean).join('\n') }
  }
  if (content.type === 'tool_result') return { category: 'tools', text: content.content }
  return null
}

function stableStringify(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(sortValue(value)) } catch { return String(value) }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortValue(nested)]))
}
