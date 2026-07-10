/**
 * Slim, read-only transcript renderer used inside SubAgentCard.
 *
 * The parent uses the full [[ChatPanel]] (avatars, bubbles, wide bodies).
 * That treatment is too heavy when the transcript is a child sub-agent shown
 * in a small card  -  especially in matrix mode where 4 rows share a row of
 * `sm:grid-cols-2`. This component renders the same [[Message]] shape but
 * plain: no user bubble, no avatar column, condensed tool-call rows.
 *
 * We intentionally do NOT hide the first user turn even though the parent
 * card header already shows the prompt (user directive: keep it visible so
 * the transcript reads top-to-bottom without implied context).
 *
 * Virtualised via [[VirtualTranscript]]  -  child sessions can produce hundreds
 * of tool calls, and matrix mode stacks 4 of them side-by-side. Without
 * virtualisation each parent turn re-mounts every nested row on every diff.
 */

import { Children, isValidElement, useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
  type GroupedContentItem,
  type ToolCallGroup,
} from './grouping.js'
import { firstLine, pickRenderer, previewValue, truncate } from './toolSummaries/index.js'
import { CodeBlock } from './CodeBlock.js'
import { VirtualTranscript } from './VirtualTranscript.js'

type Props = {
  messages: readonly Message[]
  compact?: boolean
}

export function NestedTranscript({ messages, compact = false }: Props): JSX.Element {
  const visible = messages.filter((m) => m.role !== 'system')
  const resultsByCallId = collectAllToolResults(visible)
  const groupedCallIds = collectGroupedResultCallIds(visible, resultsByCallId)
  const [pinned, setPinned] = useState(true)

  const renderItem = useCallback(
    (message: Message, index: number): JSX.Element => (
      <NestedMessage
        key={index}
        message={message}
        resultsByCallId={resultsByCallId}
        groupedCallIds={groupedCallIds}
        compact={compact}
      />
    ),
    [resultsByCallId, groupedCallIds, compact],
  )

  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col text-[12px] leading-relaxed',
        compact && 'text-[11px]',
      )}
      data-testid="nested-transcript"
    >
      <VirtualTranscript<Message>
        items={visible}
        renderItem={renderItem}
        keyFor={(_m, i) => i}
        pinnedToBottom={pinned}
        onPinnedChange={setPinned}
        itemClassName={cn('px-3 py-1', compact && 'px-2 py-0.5')}
        defaultItemHeight={40}
      />
    </div>
  )
}

function collectGroupedResultCallIds(
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
          'text-[9px] font-semibold uppercase tracking-[0.08em]',
          labelTone,
          compact && 'text-[9px]',
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
    if (role === 'assistant') return <NestedMarkdown text={content.text} compact={compact} />
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
  const renderer = pickRenderer(group.toolName)
  const rows = renderer({ calls: group.calls, results: group.results })
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={`nested-tool-group-${group.firstCallId}`}>
      {rows.map((row) => {
        const result = group.results.get(row.callId)
        const ok = result ? result.ok : true
        return (
          <div
            key={row.callId}
            className={cn(
              'flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px]',
              ok
                ? 'text-muted-foreground'
                : 'bg-rose-50/60 text-rose-800 dark:bg-rose-950/30 dark:text-rose-200',
            )}
          >
            <span
              className={cn(
                'flex-none rounded bg-background/70 px-1 text-[9px] uppercase tracking-wider',
                ok ? 'text-muted-foreground' : 'text-rose-700 dark:text-rose-300',
              )}
            >
              {group.toolName}
            </span>
            <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]">
              {row.primary}
            </span>
            {!ok ? (
              <span className="flex-none text-[9px] uppercase tracking-wider">{t('chat.transcript.failed')}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function NestedToolCall({ call }: { call: ToolCallContent }): JSX.Element {
  const preview = Object.entries(call.input)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${truncate(previewValue(v), 40)}`)
    .join('  -  ')
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
      <span className="flex-none rounded bg-background/70 px-1 text-[9px] uppercase tracking-wider">
        {call.name}
      </span>
      <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]">
        {preview || call.callId}
      </span>
    </div>
  )
}

function NestedToolResult({ result }: { result: ToolResultContent }): JSX.Element {
  const preview = truncate(firstLine(result.content), 140)
  return (
    <div
      className={cn(
        'flex min-w-0 items-start gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px]',
        result.ok
          ? 'text-muted-foreground'
          : 'bg-rose-50/60 text-rose-800 dark:bg-rose-950/30 dark:text-rose-200',
      )}
    >
      <span
        className={cn(
          'flex-none rounded bg-background/70 px-1 text-[9px] uppercase tracking-wider',
          result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-300',
        )}
      >
        {result.ok ? ' - ' : ' - '}
      </span>
      <span className="min-w-0 flex-1 truncate [overflow-wrap:anywhere]">{preview}</span>
    </div>
  )
}

function NestedMarkdown({ text, compact }: { text: string; compact: boolean }): JSX.Element {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert min-w-0 max-w-full break-words leading-snug [overflow-wrap:anywhere]',
        compact ? 'text-[11px]' : 'text-[12px]',
        'prose-p:my-1 prose-p:text-foreground prose-headings:my-1.5 prose-headings:text-foreground prose-strong:text-foreground prose-li:my-0 prose-li:text-foreground',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4',
        '[&_code]:rounded [&_code]:bg-muted/70 [&_code]:px-1 [&_code]:py-0 [&_code]:text-foreground [&_code]:before:content-[""] [&_code]:after:content-[""]',
        '[&_h1]:text-[12px] [&_h1]:font-semibold [&_h2]:text-[12px] [&_h2]:font-semibold [&_h3]:text-[11px]',
        '[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4',
        '[&_pre]:my-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted/60 [&_pre]:p-2 [&_pre]:text-[10px]',
        '[&_table]:text-[10px] [&_table]:border [&_table]:border-border/50 [&_td]:border [&_td]:border-border/50 [&_td]:px-1.5 [&_td]:py-0.5 [&_th]:border [&_th]:border-border/50 [&_th]:px-1.5 [&_th]:py-0.5',
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return <MarkdownPre>{children}</MarkdownPre>
          },
          code({ inline, className, children, ...rest }: {
            inline?: boolean
            className?: string
            children?: React.ReactNode
          }) {
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function MarkdownPre({ children }: { children?: React.ReactNode }): JSX.Element {
  const code = Children.toArray(children).find((child) => isValidElement(child))
  if (code && isValidElement<{ className?: string; children?: React.ReactNode }>(code)) {
    const className = code.props.className
    const match = /language-(\w+)/.exec(className ?? '')
    const raw = reactNodeText(code.props.children).replace(/\n$/, '')
    return <CodeBlock code={raw} lang={match?.[1]} />
  }
  return <CodeBlock code={reactNodeText(children).replace(/\n$/, '')} />
}

function reactNodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeText).join('')
  if (isValidElement<{ children?: React.ReactNode }>(node)) return reactNodeText(node.props.children)
  return ''
}
