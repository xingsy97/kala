import { useState } from 'react'
import {
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  FileText,
  Lightbulb,
  Pencil,
  Sparkles,
  Terminal,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'
import type { ApprovalRequiredEvent } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { Textarea } from '../../components/ui/textarea.js'
import { formatTokens } from '../../lib/format.js'
import { cn } from '../../lib/utils.js'
import type { TranscriptItem } from '../../transcript.js'
import { DiffPreview } from './DiffPreview.js'

type Props = {
  messages?: readonly Message[]
  items?: readonly TranscriptItem[]
  highlightIndex?: number | null
  onEditAndRerun?: (seq: number, text: string) => void
  onSuggest?: (text: string) => void
  pendingApprovals?: readonly ApprovalRequiredEvent[]
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
}

const EMPTY_SUGGESTIONS: ReadonlyArray<{
  icon: typeof Sparkles
  title: string
  prompt: string
}> = [
  {
    icon: Code2,
    title: 'Explain this repo',
    prompt: 'Give me a quick tour of this repository — what does it do, and where should I start reading?',
  },
  {
    icon: Terminal,
    title: 'Run tests and fix failures',
    prompt: 'Run the tests. If any fail, propose a fix.',
  },
  {
    icon: FileText,
    title: 'Draft a change plan',
    prompt: 'I want to add a new feature. Ask me a few clarifying questions, then draft an implementation plan.',
  },
  {
    icon: Lightbulb,
    title: 'Suggest improvements',
    prompt: 'Read the main source files and suggest three concrete improvements I could make today.',
  },
]

export function ChatPanel({
  messages,
  items,
  highlightIndex,
  onEditAndRerun,
  onSuggest,
  pendingApprovals,
  onApprovalDecision,
}: Props): JSX.Element {
  const fallbackItems: TranscriptItem[] = (messages ?? []).map((message) => ({
    kind: 'message',
    message,
  }))
  const transcriptItems = items ?? fallbackItems
  const toolNameByCallId = new Map<string, string>()
  for (const item of transcriptItems) {
    if (item.kind !== 'message') continue
    const message = item.message
    for (const content of message.content) {
      if (content.type === 'tool_call') toolNameByCallId.set(content.callId, content.name)
    }
  }
  const approvalByCallId = new Map<string, ApprovalRequiredEvent>()
  for (const a of pendingApprovals ?? []) approvalByCallId.set(a.callId, a)
  let messageIndex = -1
  const isEmpty = transcriptItems.length === 0
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      {isEmpty ? <EmptyState onSuggest={onSuggest} /> : null}
      {transcriptItems.map((item, itemIndex) => {
        if (item.kind === 'compact_boundary') {
          return <CompactBoundaryRow key={`compact-${item.seq}`} boundary={item} />
        }
        messageIndex += 1
        const currentMessageIndex = messageIndex
        return (
          <MessageRow
            key={`message-${itemIndex}`}
            index={currentMessageIndex}
            message={item.message}
            highlighted={highlightIndex === currentMessageIndex}
            toolNameByCallId={toolNameByCallId}
            approvalByCallId={approvalByCallId}
            onApprovalDecision={onApprovalDecision}
            seq={item.seq}
            onEditAndRerun={onEditAndRerun}
          />
        )
      })}
    </div>
  )
}

function EmptyState({
  onSuggest,
}: {
  onSuggest?: (text: string) => void
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-8 py-16 text-center">
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border bg-muted/40">
          <Sparkles className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          What can I help with?
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Ask a question, request code changes, or pick one of the suggestions below to get started.
        </p>
      </div>
      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {EMPTY_SUGGESTIONS.map((s) => {
          const Icon = s.icon
          const clickable = typeof onSuggest === 'function'
          return (
            <button
              key={s.title}
              type="button"
              onClick={() => onSuggest?.(s.prompt)}
              disabled={!clickable}
              className={cn(
                'group flex min-w-0 items-start gap-3 rounded-xl border bg-muted/40 p-4 text-left transition-colors',
                clickable
                  ? 'hover:border-ring hover:bg-muted cursor-pointer'
                  : 'cursor-default opacity-70',
              )}
              data-testid={`empty-suggestion-${s.title.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg border bg-background text-muted-foreground group-hover:text-foreground">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-sm font-medium text-foreground">{s.title}</div>
                <div className="line-clamp-2 text-xs text-muted-foreground">{s.prompt}</div>
              </div>
            </button>
          )
        })}
      </div>
      <div className="text-xs text-muted-foreground" data-testid="empty-state-hint">
        No messages yet — type below to begin.
      </div>
    </div>
  )
}

function CompactBoundaryRow({
  boundary,
}: {
  boundary: Extract<TranscriptItem, { kind: 'compact_boundary' }>
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 py-2" data-testid="compact-boundary">
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
      <div className="flex min-w-0 items-center gap-2 rounded-full border bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground">
        <Archive className="h-3 w-3 flex-none" />
        <span className="font-medium text-foreground">Context compacted</span>
        <span className="hidden truncate sm:inline">
          · {boundary.trigger === 'auto' ? 'Automatic compact' : 'Manual compact'} · event #{boundary.seq} ·{' '}
          {formatTokens(boundary.tokensBefore)} → {formatTokens(boundary.tokensAfter)} tokens ·{' '}
          {boundary.replacedCount} messages summarized
        </span>
        <span className="truncate sm:hidden">
          {boundary.trigger === 'auto' ? 'Auto' : 'Manual'} · {formatTokens(boundary.tokensBefore)} →{' '}
          {formatTokens(boundary.tokensAfter)}
        </span>
      </div>
      <div className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}

function MessageRow({
  index,
  message,
  highlighted,
  toolNameByCallId,
  approvalByCallId,
  onApprovalDecision,
  seq,
  onEditAndRerun,
}: {
  index: number
  message: Message
  highlighted: boolean
  toolNameByCallId: ReadonlyMap<string, string>
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  seq?: number
  onEditAndRerun?: (seq: number, text: string) => void
}): JSX.Element {
  const editable =
    message.role === 'user' &&
    seq !== undefined &&
    typeof onEditAndRerun === 'function'
  const initialText = editable
    ? message.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
    : ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initialText)

  if (editing && editable) {
    return (
      <div
        id={`msg-${index}`}
        data-message-index={index}
        className={cn(
          'group relative flex flex-col gap-2 rounded-2xl border bg-muted/40 p-4 transition-colors',
          highlighted ? 'bg-amber-50/60 dark:bg-amber-950/20' : '',
        )}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-[80px] resize-none border-0 bg-transparent p-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          data-testid={`edit-message-input-${index}`}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-7 px-3 text-xs"
            onClick={() => {
              setEditing(false)
              setDraft(initialText)
            }}
            data-testid={`edit-message-cancel-${index}`}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button
            type="button"
            className="h-7 px-3 text-xs"
            disabled={draft.trim().length === 0}
            onClick={() => {
              if (seq === undefined) return
              onEditAndRerun?.(seq, draft.trim())
              setEditing(false)
            }}
            data-testid={`edit-message-submit-${index}`}
          >
            Rerun
          </Button>
        </div>
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div
        id={`msg-${index}`}
        data-message-index={index}
        className={cn(
          'group relative flex justify-end',
          highlighted ? 'rounded-2xl bg-amber-50/60 p-1 dark:bg-amber-950/20' : '',
        )}
      >
        <div className="relative max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground shadow-sm">
          <div className="flex min-w-0 flex-col gap-2">
            {message.content.map((c, i) => (
              <ContentBlock
                key={i}
                content={c}
                role={message.role}
                toolNameByCallId={toolNameByCallId}
                approvalByCallId={approvalByCallId}
                onApprovalDecision={onApprovalDecision}
              />
            ))}
          </div>
        </div>
        {editable ? (
          <button
            type="button"
            onClick={() => {
              setDraft(initialText)
              setEditing(true)
            }}
            className="absolute -left-8 top-2 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
            title="Edit and rerun"
            data-testid={`edit-message-${index}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    )
  }

  // Assistant + tool messages: no bubble, avatar-labeled row with generous line height.
  const roleTextColor =
    message.role === 'tool'
      ? 'text-emerald-700 dark:text-emerald-400'
      : 'text-muted-foreground'
  const label = message.role === 'assistant' ? 'Assistant' : 'Tool result'

  return (
    <div
      id={`msg-${index}`}
      data-message-index={index}
      className={cn(
        'group relative flex min-w-0 gap-3',
        highlighted ? 'rounded-2xl bg-amber-50/60 p-2 -mx-2 dark:bg-amber-950/20' : '',
      )}
    >
      <div className="flex-none pt-0.5">
        <div
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-semibold uppercase tracking-wider',
            message.role === 'assistant'
              ? 'border-border bg-background text-foreground'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
          )}
          aria-label={label}
        >
          {message.role === 'assistant' ? 'AK' : <Wrench className="h-3 w-3" aria-hidden="true" />}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'mb-1 text-[11px] font-medium uppercase tracking-wider',
            roleTextColor,
          )}
        >
          {label}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {message.content.map((c, i) => (
            <ContentBlock
              key={i}
              content={c}
              role={message.role}
              toolNameByCallId={toolNameByCallId}
              approvalByCallId={approvalByCallId}
              onApprovalDecision={onApprovalDecision}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function ContentBlock({
  content,
  role,
  toolNameByCallId,
  approvalByCallId,
  onApprovalDecision,
}: {
  content: MessageContent
  role: Message['role']
  toolNameByCallId: ReadonlyMap<string, string>
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
}): JSX.Element {
  if (content.type === 'text') {
    if (role === 'assistant') return <AssistantMarkdown text={content.text} />
    if (role === 'user') {
      return (
        <div className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
          {content.text}
        </div>
      )
    }
    return (
      <div className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">
        {content.text}
      </div>
    )
  }
  if (content.type === 'tool_call') {
    return (
      <ToolCallBlock
        call={content}
        approval={approvalByCallId.get(content.callId) ?? null}
        onApprovalDecision={onApprovalDecision}
      />
    )
  }
  if (content.type === 'tool_result') {
    return (
      <ToolResultBlock
        result={content}
        toolName={toolNameByCallId.get(content.callId)}
      />
    )
  }
  if (content.type === 'thinking') return <ThinkingBlock content={content} />
  return <ImageBlock content={content} />
}

function ImageBlock({
  content,
}: {
  content: import('@agent-kernel/kernel').ImageContent
}): JSX.Element {
  const src =
    content.source.kind === 'base64'
      ? `data:${content.source.mediaType};base64,${content.source.data}`
      : content.source.path
  return (
    <img
      src={src}
      alt=""
      className="h-auto max-h-64 max-w-full rounded-lg border object-contain sm:max-w-xs"
    />
  )
}

function ThinkingBlock({
  content,
}: {
  content: import('@agent-kernel/kernel').ThinkingContent
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-w-0 items-center gap-2 rounded-full border border-dashed bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted"
      >
        <Sparkles className="h-3 w-3 flex-none" />
        <span className="font-medium">Thinking</span>
        {open ? (
          <ChevronDown className="h-3 w-3 flex-none" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-none" />
        )}
      </button>
      {open ? (
        <div className="mt-2 rounded-lg border border-dashed bg-muted/30">
          <ScrollArea>
            <pre className="min-w-0 whitespace-pre-wrap break-words px-3 py-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {content.text}
            </pre>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}

function AssistantMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert min-w-0 max-w-full break-words leading-relaxed [overflow-wrap:anywhere]',
        'prose-p:text-foreground prose-headings:text-foreground prose-strong:text-foreground prose-li:text-foreground',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-foreground [&_code]:before:content-[""] [&_code]:after:content-[""]',
        '[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm',
        '[&_img]:h-auto [&_img]:max-h-64 [&_img]:max-w-full [&_img]:rounded-lg [&_img]:border sm:[&_img]:max-w-xs',
        '[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent [&_pre]:p-0',
        '[&_pre_code]:block [&_pre_code]:min-w-max [&_pre_code]:bg-transparent [&_pre_code]:p-3 [&_pre_code]:text-foreground',
        '[&_table]:border [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2',
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return (
              <ScrollArea className="my-3 max-w-full rounded-lg border bg-muted/40">
                {children}
              </ScrollArea>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function ToolCallBlock({
  call,
  approval,
  onApprovalDecision,
}: {
  call: ToolCallContent
  approval: ApprovalRequiredEvent | null
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
}): JSX.Element {
  const isPendingApproval = approval !== null && typeof onApprovalDecision === 'function'
  const hasDiffPreview = isPendingApproval && (call.name === 'edit' || call.name === 'write')
  const [open, setOpen] = useState(isPendingApproval)
  return (
    <div
      className={cn(
        'min-w-0 max-w-full rounded-lg border transition-colors',
        isPendingApproval
          ? 'border-amber-400/60 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-950/20'
          : 'border-border',
      )}
      data-testid={
        isPendingApproval ? `tool-call-pending-${call.callId}` : undefined
      }
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'group/tool flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground transition-colors',
          isPendingApproval
            ? 'hover:bg-amber-100/40 dark:hover:bg-amber-950/30'
            : 'bg-muted/40 hover:bg-muted',
        )}
        data-testid={`tool-call-toggle-${call.callId}`}
      >
        <Wrench
          className={cn(
            'h-3.5 w-3.5 flex-none',
            isPendingApproval
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground',
          )}
        />
        <span
          className={cn(
            'font-medium',
            isPendingApproval
              ? 'text-amber-800 dark:text-amber-200'
              : 'text-muted-foreground',
          )}
        >
          {isPendingApproval ? 'Approval needed' : 'Assistant requested tool'}
        </span>
        <span className="min-w-0 max-w-[45%] truncate rounded border bg-background px-1.5 py-0.5 font-mono text-[11px]">
          {call.name}
        </span>
        <span className="flex-1" />
        <span className="hidden max-w-[35%] truncate font-mono text-[11px] text-muted-foreground sm:inline">
          {call.callId}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="flex min-w-0 flex-col gap-2 border-t border-inherit px-3 py-2">
          {isPendingApproval && hasDiffPreview ? (
            <DiffPreview toolName={call.name} input={approval.input} />
          ) : (
            <div className="overflow-hidden rounded-md border bg-muted/30">
              <ScrollArea>
                <pre className="min-w-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                  {JSON.stringify(call.input, null, 2)}
                </pre>
              </ScrollArea>
            </div>
          )}
          {isPendingApproval ? (
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onApprovalDecision?.(call.callId, 'reject')}
                data-testid="approval-reject"
                className="h-7 px-3 flex-none"
              >
                <X className="mr-1 h-3.5 w-3.5" />
                Reject
              </Button>
              <Button
                size="sm"
                onClick={() => onApprovalDecision?.(call.callId, 'approve')}
                data-testid="approval-approve"
                className="h-7 flex-none bg-emerald-600 px-3 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                Approve
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ToolResultBlock({
  result,
  toolName,
}: {
  result: ToolResultContent
  toolName?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = result.ok ? CheckCircle2 : XCircle
  const statusTone = result.ok
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400'
  const statusBadge = result.ok
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300'
  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group/tool flex w-full min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
        data-testid={`tool-result-toggle-${result.callId}`}
      >
        <Icon className={cn('h-3.5 w-3.5 flex-none', statusTone)} />
        <span className="font-medium text-muted-foreground">Tool result</span>
        {toolName ? (
          <span className="min-w-0 max-w-[45%] truncate rounded border bg-background px-1.5 py-0.5 font-mono text-[11px]">
            {toolName}
          </span>
        ) : null}
        <span
          className={cn(
            'flex-none rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider',
            statusBadge,
          )}
        >
          {result.ok ? 'Succeeded' : 'Failed'}
        </span>
        <span className="flex-1" />
        <span className="hidden max-w-[35%] truncate font-mono text-[11px] text-muted-foreground sm:inline">
          {result.callId}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="mt-2 overflow-hidden rounded-lg border bg-muted/30">
          <ScrollArea>
            <pre className="min-w-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
              {result.content}
            </pre>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}
