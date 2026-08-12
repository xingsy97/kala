import type { Message, MessageContent } from '@agent-kernel/kernel'
import type { TimelineEntry } from '../../session.js'

export const SESSION_PREVIEW_MAX_ROWS = 12
const SOURCE_MESSAGE_LIMIT = 24
const TEXT_LIMIT = 360
const DETAIL_LIMIT = 180

export type SessionPreviewItem = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  kind: 'text' | 'tool_call' | 'tool_result' | 'omitted'
  label: string
  text: string
  tone?: 'success' | 'danger' | 'muted'
}

export function projectSessionPreviewItems(
  messages: readonly Message[],
  timeline: readonly TimelineEntry[],
  streamingText: string,
  maxRows = SESSION_PREVIEW_MAX_ROWS,
): readonly SessionPreviewItem[] {
  const rows: SessionPreviewItem[] = []
  const source = previewMessages(messages, timeline)
  const start = Math.max(0, source.length - SOURCE_MESSAGE_LIMIT)
  for (let messageIndex = start; messageIndex < source.length; messageIndex += 1) {
    const message = source[messageIndex]!
    if (message.role === 'system') continue
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
      appendContent(rows, message, message.content[contentIndex]!, `${messageIndex}-${contentIndex}`)
    }
  }
  if (streamingText.trim()) appendText(rows, 'assistant', streamingText, 'streaming')
  return rows.length > maxRows ? rows.slice(-maxRows) : rows
}

function previewMessages(stateMessages: readonly Message[], timeline: readonly TimelineEntry[]): readonly Message[] {
  if (timeline.length === 0) return stateMessages
  const messages: Message[] = []
  for (const entry of timeline.slice(-48)) {
    if (entry.event.kind === 'user_message') messages.push({ role: 'user', content: [{ type: 'text', text: entry.event.text ?? '' }] })
    else if (entry.event.kind === 'llm_response') messages.push(entry.event.message)
    else if (entry.event.kind === 'tool_result') messages.push({ role: 'tool', content: [{ type: 'tool_result', callId: entry.event.callId, ok: entry.event.ok, content: entry.event.content }] })
  }
  return messages.length > 0 ? messages : stateMessages
}

function appendContent(rows: SessionPreviewItem[], message: Message, content: MessageContent, id: string): void {
  if (content.type === 'text') {
    const role = message.role === 'system' ? 'assistant' : message.role
    appendText(rows, role, content.text, id)
    return
  }
  if (content.type === 'thinking') {
    const text = plainText(content.text)
    if (text) rows.push({ id, role: 'assistant', kind: 'text', label: 'Thinking', text: clip(text, TEXT_LIMIT), tone: 'muted' })
    return
  }
  if (content.type === 'tool_call') {
    const intent = content.intent?.trim()
    rows.push({
      id,
      role: 'assistant',
      kind: 'tool_call',
      label: content.name,
      text: clip(intent || summarizeInput(content.input), DETAIL_LIMIT),
      tone: 'muted',
    })
    return
  }
  if (content.type === 'tool_result') {
    rows.push({
      id,
      role: 'tool',
      kind: 'tool_result',
      label: content.ok ? 'Succeeded' : 'Failed',
      text: clip(plainText(content.content), DETAIL_LIMIT),
      tone: content.ok ? 'success' : 'danger',
    })
    return
  }
  if (content.type === 'image') {
    rows.push({ id, role: message.role === 'system' ? 'assistant' : message.role, kind: 'omitted', label: 'Image', text: 'Media omitted from Session preview', tone: 'muted' })
  }
}

function appendText(rows: SessionPreviewItem[], role: SessionPreviewItem['role'], source: string, id: string): void {
  const fence = /```([^\n`]*)\n?[\s\S]*?```/g
  let cursor = 0
  let part = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(source)) !== null) {
    appendPlainText(rows, role, source.slice(cursor, match.index), `${id}-text-${part++}`)
    const language = match[1]?.trim().toLowerCase()
    rows.push({
      id: `${id}-omitted-${part++}`,
      role,
      kind: 'omitted',
      label: language === 'mermaid' ? 'Diagram' : language ? `${language} code` : 'Code block',
      text: 'Complex content omitted from Session preview',
      tone: 'muted',
    })
    cursor = match.index + match[0].length
  }
  appendPlainText(rows, role, source.slice(cursor), `${id}-text-${part}`)
}

function appendPlainText(rows: SessionPreviewItem[], role: SessionPreviewItem['role'], source: string, id: string): void {
  const text = plainText(source)
  if (!text) return
  rows.push({ id, role, kind: 'text', label: roleLabel(role), text: clip(text, TEXT_LIMIT) })
}

function plainText(source: string): string {
  return source
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function summarizeInput(input: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(input).filter(([key]) => key !== '_intent').slice(0, 2)
  if (entries.length === 0) return 'Tool request'
  return entries.map(([key, value]) => `${key}: ${previewValue(value)}`).join(' · ')
}

function previewValue(value: unknown): string {
  if (typeof value === 'string') return clip(value.replace(/\s+/g, ' ').trim(), 90)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `${value.length} items`
  if (value && typeof value === 'object') return 'structured input'
  return String(value ?? '')
}

function roleLabel(role: SessionPreviewItem['role']): string {
  return role === 'assistant' ? 'Assistant' : role === 'user' ? 'User' : 'Tool'
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}
