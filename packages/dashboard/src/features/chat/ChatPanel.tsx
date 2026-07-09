import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'

type Props = {
  messages: readonly Message[]
  highlightIndex?: number | null
}

export function ChatPanel({ messages, highlightIndex }: Props): JSX.Element {
  return (
    <div className="flex flex-col divide-y divide-slate-100 dark:divide-slate-900">
      {messages.length === 0 ? (
        <div className="px-6 py-8 text-slate-500 text-sm">No messages yet.</div>
      ) : null}
      {messages.map((m, i) => (
        <MessageRow
          key={i}
          index={i}
          message={m}
          highlighted={highlightIndex === i}
        />
      ))}
    </div>
  )
}

function MessageRow({
  index,
  message,
  highlighted,
}: {
  index: number
  message: Message
  highlighted: boolean
}): JSX.Element {
  const label =
    message.role === 'user'
      ? 'You'
      : message.role === 'assistant'
        ? 'Assistant'
        : message.role
  const labelColor =
    message.role === 'user'
      ? 'text-slate-500 dark:text-slate-400'
      : 'text-amber-700 dark:text-amber-400'
  return (
    <div
      id={`msg-${index}`}
      data-message-index={index}
      className={`px-6 py-4 transition-colors ${
        highlighted ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''
      }`}
    >
      <div
        className={`text-[11px] uppercase tracking-wider font-medium mb-2 ${labelColor}`}
      >
        {label}
      </div>
      <div className="flex flex-col gap-2">
        {message.content.map((c, i) => (
          <ContentBlock key={i} content={c} role={message.role} />
        ))}
      </div>
    </div>
  )
}

function ContentBlock({
  content,
  role,
}: {
  content: MessageContent
  role: Message['role']
}): JSX.Element {
  if (content.type === 'text') {
    if (role === 'assistant') return <AssistantMarkdown text={content.text} />
    return (
      <div className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">
        {content.text}
      </div>
    )
  }
  if (content.type === 'tool_call') return <ToolCallBlock call={content} />
  if (content.type === 'tool_result') return <ToolResultBlock result={content} />
  return <ImageBlock content={content} />
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

function AssistantMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-slate-800 dark:text-slate-100 leading-relaxed [&_pre]:bg-slate-50 dark:[&_pre]:bg-slate-950 [&_pre]:border [&_pre]:border-slate-200 dark:[&_pre]:border-slate-800 [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto [&_code]:text-amber-700 dark:[&_code]:text-amber-200 [&_code]:bg-slate-100 dark:[&_code]:bg-slate-900 [&_code]:px-1 [&_code]:rounded [&_pre_code]:bg-transparent [&_pre_code]:text-slate-800 dark:[&_pre_code]:text-slate-100 [&_pre_code]:p-0 [&_a]:text-sky-600 dark:[&_a]:text-sky-400 [&_a]:underline [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:border [&_table]:border-slate-300 dark:[&_table]:border-slate-700 [&_th]:border [&_th]:border-slate-300 dark:[&_th]:border-slate-700 [&_th]:px-2 [&_td]:border [&_td]:border-slate-300 dark:[&_td]:border-slate-700 [&_td]:px-2 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 dark:[&_blockquote]:border-slate-600 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600 dark:[&_blockquote]:text-slate-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function ToolCallBlock({ call }: { call: ToolCallContent }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="font-mono text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-amber-700 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300"
        data-testid={`tool-call-toggle-${call.callId}`}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span>→ {call.name}</span>
      </button>
      {open ? (
        <pre className="mt-1 ml-4 border-l border-amber-300/50 dark:border-amber-800/40 pl-2 text-amber-800/80 dark:text-amber-100/70 whitespace-pre-wrap">
          {JSON.stringify(call.input, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

function ToolResultBlock({
  result,
}: {
  result: ToolResultContent
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const color = result.ok
    ? 'text-emerald-700 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300'
    : 'text-rose-700 dark:text-rose-400 hover:text-rose-600 dark:hover:text-rose-300'
  const borderColor = result.ok
    ? 'border-emerald-300/50 dark:border-emerald-800/40'
    : 'border-rose-300/50 dark:border-rose-800/40'
  return (
    <div className="font-mono text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 ${color}`}
        data-testid={`tool-result-toggle-${result.callId}`}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span>← {result.ok ? 'ok' : 'err'}</span>
      </button>
      {open ? (
        <pre
          className={`mt-1 ml-4 border-l ${borderColor} pl-2 whitespace-pre-wrap text-slate-700 dark:text-slate-200`}
        >
          {result.content}
        </pre>
      ) : null}
    </div>
  )
}
