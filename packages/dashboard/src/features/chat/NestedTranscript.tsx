/**
 * Slim, read-only transcript renderer used inside SubAgentCard.
 *
 * The parent uses the full [[ChatPanel]] (avatars, bubbles, wide bodies).
 * That treatment is too heavy when the transcript is a child sub-agent shown
 * in a small card — especially in matrix mode where 4 rows share a row of
 * `sm:grid-cols-2`. This component renders the same [[Message]] shape but
 * plain: no user bubble, no avatar column, condensed tool-call rows.
 *
 * We intentionally do NOT hide the first user turn even though the parent
 * card header already shows the prompt (user directive: keep it visible so
 * the transcript reads top-to-bottom without implied context).
 *
 * Virtualised via [[VirtualTranscript]] — child sessions can produce hundreds
 * of tool calls, and matrix mode stacks 4 of them side-by-side. Without
 * virtualisation each parent turn re-mounts every nested row on every diff.
 */

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'

import { cn } from '../../lib/utils.js'
import {
  collectAllToolResults,
  groupConsecutiveToolCalls,
  makeToolCallGroup,
  type GroupedContentItem,
  type ToolCallGroup,
} from './grouping.js'
import { firstLine, pickRenderer, previewValue, truncate, type SummaryRow } from './toolSummaries/index.js'
import { VirtualTranscript } from './VirtualTranscript.js'

type Props = {
  messages: readonly Message[]
  compact?: boolean
  virtualized?: boolean
}

type NestedRenderItem =
  | { kind: 'message'; message: Message; messageIndex: number }
  | { kind: 'tool_activity'; group: ToolCallGroup; messageIndex: number }

type NestedSummaryRow = SummaryRow & { toolName: string }

export function NestedTranscript({ messages, compact = false, virtualized = true }: Props): JSX.Element {
  const { resultsByCallId, groupedCallIds, renderItems } = useMemo(() => {
    const visible = messages.filter((message) => message.role !== 'system')
    const results = collectAllToolResults(visible)
    return {
      resultsByCallId: results,
      groupedCallIds: collectNestedGroupedResultCallIds(visible, results),
      renderItems: collectNestedRenderItems(visible, results),
    }
  }, [messages])
  const [pinned, setPinned] = useState(true)

  const renderItem = useCallback(
    (item: NestedRenderItem): JSX.Element => {
      if (item.kind === 'tool_activity') {
        return (
          <RoleColumn label="Assistant" tone="assistant" compact={compact}>
            <NestedToolGroup group={item.group} />
          </RoleColumn>
        )
      }
      return (
        <NestedMessage
          message={item.message}
          resultsByCallId={resultsByCallId}
          groupedCallIds={groupedCallIds}
          compact={compact}
        />
      )
    },
    [resultsByCallId, groupedCallIds, compact],
  )

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col text-[0.8125rem] leading-relaxed',
        virtualized && 'flex-1',
        compact && 'text-xs',
      )}
      data-testid="nested-transcript"
      data-virtualized={virtualized ? 'true' : 'false'}
    >
      {virtualized ? (
        <VirtualTranscript<NestedRenderItem>
          items={renderItems}
          renderItem={renderItem}
          keyFor={(item, i) => item.kind === 'tool_activity' ? `tool-${item.group.firstCallId}` : `msg-${item.messageIndex}-${i}`}
          pinnedToBottom={pinned}
          onPinnedChange={setPinned}
          itemClassName={cn('px-3 py-1', compact && 'px-2 py-0.5')}
          defaultItemHeight={40}
        />
      ) : (
        <div>
          {renderItems.map((item, index) => (
            <div
              key={item.kind === 'tool_activity' ? `tool-${item.group.firstCallId}` : `msg-${item.messageIndex}-${index}`}
              className={cn('px-3 py-1', compact && 'px-2 py-0.5')}
            >
              {renderItem(item)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function collectNestedGroupedResultCallIds(
  messages: readonly Message[],
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
): ReadonlySet<string> {
  const set = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const g of groupConsecutiveToolCalls(m.content, resultsByCallId)) {
      if (g.kind === 'tool_call_group') for (const c of g.calls) set.add(c.callId)
    }
  }
  return set
}

function collectNestedRenderItems(
  messages: readonly Message[],
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
): NestedRenderItem[] {
  const out: NestedRenderItem[] = []
  let i = 0

  while (i < messages.length) {
    const group = collectNestedToolActivity(messages, i, resultsByCallId)
    if (group) {
      out.push({ kind: 'tool_activity', group, messageIndex: i })
      i = skipNestedToolActivity(messages, i, new Set(group.calls.map((call) => call.callId)))
      continue
    }

    const message = messages[i]!
    out.push({ kind: 'message', message, messageIndex: i })
    i += 1
  }
  return out
}

function collectNestedToolActivity(
  messages: readonly Message[],
  startIndex: number,
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
): ToolCallGroup | null {
  if (!isPureToolCallAssistantMessage(messages[startIndex])) return null

  const calls: ToolCallContent[] = []
  const knownCallIds = new Set<string>()
  let i = startIndex

  while (i < messages.length) {
    const assistantMessage = messages[i]
    if (!isPureToolCallAssistantMessage(assistantMessage)) break
    for (const content of assistantMessage.content) {
      calls.push(content)
      knownCallIds.add(content.callId)
    }
    i += 1

    while (i < messages.length && isToolResultMessageForKnownCalls(messages[i], knownCallIds)) {
      i += 1
    }
  }

  if (calls.length < 2) return null
  return makeToolCallGroup(calls, resultsByCallId, true)
}

function skipNestedToolActivity(
  messages: readonly Message[],
  startIndex: number,
  knownCallIds: ReadonlySet<string>,
): number {
  let i = startIndex
  while (i < messages.length) {
    if (!isPureToolCallAssistantMessage(messages[i])) break
    i += 1
    while (i < messages.length && isToolResultMessageForKnownCalls(messages[i], knownCallIds)) {
      i += 1
    }
  }
  return i
}

function isPureToolCallAssistantMessage(
  message: Message | undefined,
): message is Message & { role: 'assistant'; content: ToolCallContent[] } {
  if (!message || message.role !== 'assistant' || message.content.length === 0) return false
  return message.content.every((content) => content.type === 'tool_call')
}

function isToolResultMessageForKnownCalls(
  message: Message | undefined,
  knownCallIds: ReadonlySet<string>,
): boolean {
  if (!message || message.role !== 'tool' || message.content.length === 0) return false
  return message.content.every(
    (content) => content.type === 'tool_result' && knownCallIds.has(content.callId),
  )
}

function NestedMessage({
  message,
  resultsByCallId,
  groupedCallIds,
  compact,
}: {
  message: Message
  resultsByCallId: ReadonlyMap<string, ToolResultContent>
  groupedCallIds: ReadonlySet<string>
  compact: boolean
}): JSX.Element | null {
  const visibleContent: MessageContent[] =
    message.role === 'tool'
      ? message.content.filter(
          (c) => c.type !== 'tool_result' || !groupedCallIds.has(c.callId),
        )
      : [...message.content]
  if (visibleContent.length === 0) return null

  if (message.role === 'user') {
    return (
      <RoleColumn label="User" tone="user" compact={compact}>
        {visibleContent.map((c, i) => (
          <NestedContent key={i} content={c} role="user" compact={compact} />
        ))}
      </RoleColumn>
    )
  }

  if (message.role === 'tool') {
    return (
      <RoleColumn label="Tool" tone="tool" compact={compact}>
        {visibleContent.map((c, i) => (
          <NestedContent key={i} content={c} role="tool" compact={compact} />
        ))}
      </RoleColumn>
    )
  }

  const grouped = groupConsecutiveToolCalls(visibleContent, resultsByCallId)
  return (
    <RoleColumn label="Assistant" tone="assistant" compact={compact}>
      {grouped.map((item, i) => (
        <NestedGroupItem key={i} item={item} compact={compact} />
      ))}
    </RoleColumn>
  )
}

function RoleColumn({
  label,
  tone,
  compact,
  children,
}: {
  label: string
  tone: 'user' | 'assistant' | 'tool'
  compact: boolean
  children: React.ReactNode
}): JSX.Element {
  const labelTone =
    tone === 'user'
      ? 'text-sky-700 dark:text-sky-400'
      : tone === 'tool'
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-muted-foreground'
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className={cn(
          'text-[0.625rem] font-semibold uppercase tracking-[0.08em]',
          labelTone,
          compact && 'text-[0.625rem]',
        )}
      >
        {label}
      </div>
      <div className="flex min-w-0 flex-col gap-1 pl-2 [border-left:2px_solid_hsl(var(--border)/0.5)]">
        {children}
      </div>
    </div>
  )
}

function NestedContent({
  content,
  role,
  compact,
}: {
  content: MessageContent
  role: Message['role']
  compact: boolean
}): JSX.Element | null {
  if (content.type === 'text') {
    if (role === 'assistant') return <NestedPreviewText text={content.text} compact={compact} />
    return (
      <div className="min-w-0 whitespace-pre-wrap break-words text-foreground [overflow-wrap:anywhere]">
        {content.text}
      </div>
    )
  }
  if (content.type === 'tool_call') {
    return <NestedToolCall call={content} />
  }
  if (content.type === 'tool_result') {
    return <NestedToolResult result={content} />
  }
  if (content.type === 'thinking') {
    return (
      <div className="italic text-muted-foreground">
        {truncate(firstLine(content.text), 200)}
      </div>
    )
  }
  return null
}

function NestedGroupItem({
  item,
  compact,
}: {
  item: GroupedContentItem
  compact: boolean
}): JSX.Element | null {
  if (item.kind === 'single') {
    return <NestedContent content={item.content} role="assistant" compact={compact} />
  }
  return <NestedToolGroup group={item} />
}

function NestedToolGroup({ group }: { group: ToolCallGroup }): JSX.Element {
  const { t } = useTranslation()
  const rows = group.mixed
    ? group.calls.map((call) => {
        const renderer = pickRenderer(call.name)
        const row = renderer({ calls: [call], results: group.results })[0]
        return row ? { ...row, toolName: call.name } : null
      }).filter((row): row is NonNullable<typeof row> => !!row)
    : pickRenderer(group.toolName)({ calls: group.calls, results: group.results }).map((row) => ({
        ...row,
        toolName: group.toolName,
      }))
  const [open, setOpen] = useState(false)
  const failed = group.calls.filter((call) => group.results.get(call.callId)?.ok === false).length
  const succeeded = group.calls.filter((call) => group.results.get(call.callId)?.ok === true).length
  const running = group.calls.length - failed - succeeded
  const toolMix = summarizeNestedToolMix(group.calls)

  if (group.mixed) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5" data-testid={`nested-tool-group-${group.firstCallId}`}>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded bg-muted/60 px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="flex-none rounded bg-primary px-1 text-[0.5625rem] font-medium uppercase tracking-wider text-primary-foreground">
            Tool activity
          </span>
          <span className="flex-none font-mono text-[0.625rem] text-foreground">{group.calls.length} ops</span>
          <span className="min-w-0 flex-1 truncate" title={toolMix}>{toolMix}</span>
          {failed > 0 ? <NestedStatusBadge tone="failed" label={`${failed} ${t('chat.transcript.failed')}`} /> : null}
          {succeeded > 0 ? <NestedStatusBadge tone="succeeded" label={`${succeeded} Succeeded`} /> : null}
          {running > 0 ? <NestedStatusBadge tone="running" label={`${running} Running`} /> : null}
        </button>
        {open ? <NestedToolRows rows={rows} group={group} /> : null}
      </div>
    )
  }

  return <NestedToolRows rows={rows} group={group} />
}

function NestedToolRows({
  rows,
  group,
}: {
  rows: NestedSummaryRow[]
  group: ToolCallGroup
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={`nested-tool-group-${group.firstCallId}`}>
      {rows.map((row) => {
        const result = group.results.get(row.callId)
        const ok = result ? result.ok : true
        return (
          <div
            key={row.callId}
            className={cn(
              'flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 font-mono text-[0.6875rem]',
              ok
                ? 'text-muted-foreground'
                : 'bg-rose-50/60 text-rose-800 dark:bg-rose-950/30 dark:text-rose-200',
            )}
          >
            <span
              className={cn(
                'flex-none rounded bg-background/70 px-1 text-[0.5625rem] uppercase tracking-wider',
                ok ? 'text-muted-foreground' : 'text-rose-700 dark:text-rose-300',
              )}
            >
              {row.toolName}
            </span>
            <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]">
              {group.calls.find((call) => call.callId === row.callId)?.intent ?? row.primary}
            </span>
            {!ok ? (
              <span className="flex-none text-[0.5625rem] uppercase tracking-wider">{t('chat.transcript.failed')}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function NestedStatusBadge({
  tone,
  label,
}: {
  tone: 'failed' | 'succeeded' | 'running'
  label: string
}): JSX.Element {
  const className = tone === 'failed'
    ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
    : tone === 'succeeded'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
      : 'bg-background/80 text-muted-foreground'
  return (
    <span className={cn('flex-none rounded px-1 text-[0.5625rem] uppercase tracking-wider', className)}>
      {label}
    </span>
  )
}

function summarizeNestedToolMix(calls: readonly ToolCallContent[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  return [...counts.entries()].map(([name, count]) => `${name} ${count}`).join(', ')
}

function NestedToolCall({ call }: { call: ToolCallContent }): JSX.Element {
  const preview = Object.entries(call.input)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${truncate(previewValue(v), 40)}`)
    .join(' · ')
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[0.625rem] text-muted-foreground">
      <span className="flex-none rounded bg-background/70 px-1 text-[0.5625rem] uppercase tracking-wider">
        {call.name}
      </span>
      <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]" title={call.intent ?? undefined}>
        {call.intent ?? (preview || call.callId)}
      </span>
    </div>
  )
}

function NestedToolResult({ result }: { result: ToolResultContent }): JSX.Element {
  const preview = truncate(firstLine(result.content), 140)
  return (
    <div
      className={cn(
        'flex min-w-0 items-start gap-1.5 rounded px-1.5 py-0.5 font-mono text-[0.625rem]',
        result.ok
          ? 'text-muted-foreground'
          : 'bg-rose-50/60 text-rose-800 dark:bg-rose-950/30 dark:text-rose-200',
      )}
    >
      <span
        className={cn(
          'flex-none rounded bg-background/70 px-1 text-[0.5625rem] uppercase tracking-wider',
          result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-300',
        )}
      >
        {result.ok ? '✓' : '✗'}
      </span>
      <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]">{preview}</span>
    </div>
  )
}

const NESTED_PREVIEW_TEXT_LIMIT = 1_200

function NestedPreviewText({ text, compact }: { text: string; compact: boolean }): JSX.Element {
  const { t } = useTranslation()
  const parts = useMemo(() => lightweightPreviewParts(text), [text])
  return (
    <div className={cn('min-w-0 max-w-full space-y-1 break-words leading-snug text-foreground [overflow-wrap:anywhere]', compact ? 'text-[0.6875rem]' : 'text-[0.75rem]')}>
      {parts.map((part, index) => part.kind === 'text' ? (
        <div key={index} className="whitespace-pre-wrap">{part.text}</div>
      ) : (
        <div key={index} className="flex items-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/40 px-2 py-1.5 text-[0.625rem] text-muted-foreground" data-testid="nested-complex-content-omitted">
          <span className="rounded bg-background/80 px-1.5 py-0.5 font-medium uppercase tracking-wider">{part.label}</span>
          <span>{t('chatCommon.complexContentOmitted')}</span>
        </div>
      ))}
    </div>
  )
}

type NestedPreviewPart = { kind: 'text'; text: string } | { kind: 'omitted'; label: string }

function lightweightPreviewParts(source: string): NestedPreviewPart[] {
  const parts: NestedPreviewPart[] = []
  const fence = /```([^\n`]*)\n?[\s\S]*?```/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(source)) !== null) {
    appendPreviewText(parts, source.slice(cursor, match.index))
    const language = match[1]?.trim().toLowerCase()
    parts.push({ kind: 'omitted', label: language === 'mermaid' ? 'Diagram' : language ? `${language} code` : 'Code block' })
    cursor = match.index + match[0].length
  }
  appendPreviewText(parts, source.slice(cursor))
  if (parts.length === 0) parts.push({ kind: 'text', text: '' })
  return parts
}

function appendPreviewText(parts: NestedPreviewPart[], raw: string): void {
  const normalized = raw
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
  if (!normalized) return
  const consumed = parts.reduce((total, part) => total + (part.kind === 'text' ? part.text.length : 0), 0)
  const remaining = NESTED_PREVIEW_TEXT_LIMIT - consumed
  if (remaining <= 0) return
  const clipped = normalized.length > remaining ? `${normalized.slice(0, Math.max(0, remaining - 1))}…` : normalized
  parts.push({ kind: 'text', text: clipped })
}
