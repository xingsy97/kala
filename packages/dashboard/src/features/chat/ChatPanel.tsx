import { useState } from 'react'
import { Archive, CheckCircle2, ChevronDown, ChevronRight, Pencil, Sparkles, Wrench, X, XCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'

import { Button } from '../../components/ui/button.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { Textarea } from '../../components/ui/textarea.js'
import type { TranscriptItem } from '../../transcript.js'

type Props = {
  messages?: readonly Message[]
  items?: readonly TranscriptItem[]
  highlightIndex?: number | null
  onEditAndRerun?: (seq: number, text: string) => void
}

export function ChatPanel({ messages, items, highlightIndex, onEditAndRerun }: Props): JSX.Element {
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
  let messageIndex = -1
  return (
    <div className="flex min-w-0 flex-col divide-y divide-slate-100 dark:divide-slate-900">
      {transcriptItems.length === 0 ? (
        <div className="px-6 py-8 text-slate-500 text-sm">No messages yet.</div>
      ) : null}
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
            seq={item.seq}
            onEditAndRerun={onEditAndRerun}
          />
        )
      })}
    </div>
  )
}

function CompactBoundaryRow({ boundary }: { boundary: Extract<TranscriptItem, { kind: 'compact_boundary' }> }): JSX.Element {
  return (
    <div
      className="px-6 py-3 bg-sky-50/70 text-sky-900 dark:bg-sky-950/25 dark:text-sky-100"
      data-testid="compact-boundary"
    >
      <div className="flex min-w-0 items-center gap-3 rounded border border-sky-200 bg-white/70 px-3 py-2 text-xs dark:border-sky-900/70 dark:bg-slate-950/60">
        <Archive className="h-4 w-4 flex-none text-sky-600 dark:text-sky-300" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">Context compacted</div>
          <div className="mt-0.5 truncate text-[11px] text-sky-700/80 dark:text-sky-200/75">
            {boundary.trigger === 'auto' ? 'Automatic compact' : 'Manual compact'} · event #{boundary.seq} · {formatTokens(boundary.tokensBefore)} → {formatTokens(boundary.tokensAfter)} tokens · {boundary.replacedCount} messages summarized
          </div>
        </div>
      </div>
    </div>
  )
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function MessageRow({
  index,
  message,
  highlighted,
  toolNameByCallId,
  seq,
  onEditAndRerun,
}: {
  index: number
  message: Message
  highlighted: boolean
  toolNameByCallId: ReadonlyMap<string, string>
  seq?: number
  onEditAndRerun?: (seq: number, text: string) => void
}): JSX.Element {
  const label = roleLabel(message.role)
  const labelColor =
    message.role === 'user'
      ? 'text-slate-500 dark:text-slate-400'
      : message.role === 'tool'
        ? 'text-emerald-700 dark:text-emerald-400'
      : 'text-amber-700 dark:text-amber-400'
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
  return (
    <div
      id={`msg-${index}`}
      data-message-index={index}
      className={`group relative min-w-0 overflow-hidden px-6 py-4 transition-colors ${
        highlighted ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''
      }`}
    >
      <div
        className={`text-[11px] uppercase tracking-wider font-medium mb-2 ${labelColor}`}
      >
        {label}
      </div>
      {editing && editable ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[80px] text-sm"
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
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          {message.content.map((c, i) => (
            <ContentBlock
              key={i}
              content={c}
              role={message.role}
              toolNameByCallId={toolNameByCallId}
            />
          ))}
        </div>
      )}
      {editable && !editing ? (
        <button
          type="button"
          onClick={() => {
            setDraft(initialText)
            setEditing(true)
          }}
          className="absolute right-3 top-3 rounded p-1 text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          title="Edit and rerun"
          data-testid={`edit-message-${index}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}

function ContentBlock({
  content,
  role,
  toolNameByCallId,
}: {
  content: MessageContent
  role: Message['role']
  toolNameByCallId: ReadonlyMap<string, string>
}): JSX.Element {
  if (content.type === 'text') {
    if (role === 'assistant') return <AssistantMarkdown text={content.text} />
    return (
      <div className="min-w-0 whitespace-pre-wrap break-words text-sm text-slate-800 [overflow-wrap:anywhere] dark:text-slate-100">
        {content.text}
      </div>
    )
  }
  if (content.type === 'tool_call') return <ToolCallBlock call={content} />
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

function roleLabel(role: Message['role']): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'Assistant'
  if (role === 'tool') return 'Tool result'
  return role
}

function ImageBlock({ content }: { content: import('@agent-kernel/kernel').ImageContent }): JSX.Element {
  const src =
    content.source.kind === 'base64'
      ? `data:${content.source.mediaType};base64,${content.source.data}`
      : content.source.path
  return (
    <img
      src={src}
      alt=""
      className="max-w-xs max-h-64 rounded border border-slate-200 dark:border-slate-800"
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
    <div className="min-w-0 max-w-full overflow-hidden rounded border border-violet-200 bg-violet-50/60 text-xs dark:border-violet-900/60 dark:bg-violet-950/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-violet-800 hover:bg-violet-100/70 dark:text-violet-200 dark:hover:bg-violet-900/30"
      >
        <Sparkles className="h-3.5 w-3.5 flex-none" />
        <span className="font-medium">Thinking</span>
        <span className="flex-1" />
        {open ? (
          <ChevronDown className="h-3 w-3 flex-none" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-none" />
        )}
      </button>
      {open ? (
        <ScrollArea className="border-t border-violet-200 dark:border-violet-900/60">
          <pre className="min-w-0 whitespace-pre-wrap break-words px-3 py-2 text-violet-900/90 [overflow-wrap:anywhere] dark:text-violet-100/80">
            {content.text}
          </pre>
        </ScrollArea>
      ) : null}
    </div>
  )
}

function AssistantMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="prose prose-sm dark:prose-invert min-w-0 max-w-full break-words text-slate-800 leading-relaxed [overflow-wrap:anywhere] dark:text-slate-100 [&_a]:text-sky-600 dark:[&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 dark:[&_blockquote]:border-slate-600 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600 dark:[&_blockquote]:text-slate-300 [&_code]:rounded [&_code]:bg-slate-100 dark:[&_code]:bg-slate-900 [&_code]:px-1 [&_code]:text-amber-700 dark:[&_code]:text-amber-200 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:m-0 [&_pre]:overflow-visible [&_pre]:bg-transparent [&_pre]:p-0 [&_pre_code]:block [&_pre_code]:min-w-max [&_pre_code]:bg-transparent [&_pre_code]:p-2 [&_pre_code]:text-slate-800 dark:[&_pre_code]:text-slate-100 [&_table]:border [&_table]:border-slate-300 dark:[&_table]:border-slate-700 [&_td]:border [&_td]:border-slate-300 dark:[&_td]:border-slate-700 [&_td]:px-2 [&_th]:border [&_th]:border-slate-300 dark:[&_th]:border-slate-700 [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return (
              <ScrollArea className="my-2 max-w-full rounded border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
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

function ToolCallBlock({ call }: { call: ToolCallContent }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded border border-amber-200 bg-amber-50/70 text-xs dark:border-amber-900/60 dark:bg-amber-950/25">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-amber-800 hover:bg-amber-100/70 dark:text-amber-200 dark:hover:bg-amber-900/30"
        data-testid={`tool-call-toggle-${call.callId}`}
      >
        <Wrench className="h-3.5 w-3.5 flex-none" />
        <span className="font-medium">Assistant requested tool</span>
        <span className="min-w-0 max-w-[45%] truncate rounded bg-white/70 px-1.5 py-0.5 font-mono dark:bg-slate-950/60">
          {call.name}
        </span>
        <span className="flex-1" />
        <span className="min-w-0 max-w-[35%] truncate font-mono text-[11px] text-amber-700/75 dark:text-amber-200/70">
          {call.callId}
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3 flex-none" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-none" />
        )}
      </button>
      {open ? (
        <ScrollArea className="border-t border-amber-200 dark:border-amber-900/60">
          <pre className="min-w-0 whitespace-pre-wrap break-words px-3 py-2 text-amber-900/90 [overflow-wrap:anywhere] dark:text-amber-100/80">
            {JSON.stringify(call.input, null, 2)}
          </pre>
        </ScrollArea>
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
  const tone = result.ok
    ? 'border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/25 dark:text-emerald-200'
    : 'border-rose-200 bg-rose-50/70 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/25 dark:text-rose-200'
  const hover = result.ok
    ? 'hover:bg-emerald-100/70 dark:hover:bg-emerald-900/30'
    : 'hover:bg-rose-100/70 dark:hover:bg-rose-900/30'
  const border = result.ok ? 'border-emerald-200 dark:border-emerald-900/60' : 'border-rose-200 dark:border-rose-900/60'
  return (
    <div className={`min-w-0 max-w-full overflow-hidden rounded border text-xs ${tone}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left ${hover}`}
        data-testid={`tool-result-toggle-${result.callId}`}
      >
        <Icon className="h-3.5 w-3.5 flex-none" />
        <span className="font-medium">Tool result</span>
        {toolName ? (
          <span className="min-w-0 max-w-[45%] truncate rounded bg-white/70 px-1.5 py-0.5 font-mono dark:bg-slate-950/60">
            {toolName}
          </span>
        ) : null}
        <span className="rounded bg-white/70 px-1.5 py-0.5 dark:bg-slate-950/60">
          {result.ok ? 'Succeeded' : 'Failed'}
        </span>
        <span className="flex-1" />
        <span className="min-w-0 max-w-[35%] truncate font-mono text-[11px] opacity-75">{result.callId}</span>
        {open ? (
          <ChevronDown className="h-3 w-3 flex-none" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-none" />
        )}
      </button>
      {open ? (
        <ScrollArea className={`border-t ${border}`}>
          <pre className="min-w-0 whitespace-pre-wrap break-words px-3 py-2 text-slate-700 [overflow-wrap:anywhere] dark:text-slate-200">
            {result.content}
          </pre>
        </ScrollArea>
      ) : null}
    </div>
  )
}
