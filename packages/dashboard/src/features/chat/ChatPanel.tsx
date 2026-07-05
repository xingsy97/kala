import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Wrench, XCircle } from 'lucide-react'
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
  const toolNameByCallId = new Map<string, string>()
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === 'tool_call') toolNameByCallId.set(content.callId, content.name)
    }
  }
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
          toolNameByCallId={toolNameByCallId}
        />
      ))}
    </div>
  )
}

function MessageRow({
  index,
  message,
  highlighted,
  toolNameByCallId,
}: {
  index: number
  message: Message
  highlighted: boolean
  toolNameByCallId: ReadonlyMap<string, string>
}): JSX.Element {
  const label = roleLabel(message.role)
  const labelColor =
    message.role === 'user'
      ? 'text-slate-500 dark:text-slate-400'
      : message.role === 'tool'
        ? 'text-emerald-700 dark:text-emerald-400'
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
          <ContentBlock
            key={i}
            content={c}
            role={message.role}
            toolNameByCallId={toolNameByCallId}
          />
        ))}
      </div>
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
      <div className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">
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
    <div className="rounded border border-amber-200 bg-amber-50/70 text-xs dark:border-amber-900/60 dark:bg-amber-950/25">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-amber-800 hover:bg-amber-100/70 dark:text-amber-200 dark:hover:bg-amber-900/30"
        data-testid={`tool-call-toggle-${call.callId}`}
      >
        <Wrench className="h-3.5 w-3.5 flex-none" />
        <span className="font-medium">Assistant requested tool</span>
        <span className="font-mono rounded bg-white/70 px-1.5 py-0.5 dark:bg-slate-950/60">
          {call.name}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-amber-700/75 dark:text-amber-200/70">
          {call.callId}
        </span>
        {open ? (
          <ChevronDown className="h-3 w-3 flex-none" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-none" />
        )}
      </button>
      {open ? (
        <pre className="border-t border-amber-200 px-3 py-2 text-amber-900/90 dark:border-amber-900/60 dark:text-amber-100/80 whitespace-pre-wrap overflow-x-auto">
          {JSON.stringify(call.input, null, 2)}
        </pre>
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
    <div className={`rounded border text-xs ${tone}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left ${hover}`}
        data-testid={`tool-result-toggle-${result.callId}`}
      >
        <Icon className="h-3.5 w-3.5 flex-none" />
        <span className="font-medium">Tool result</span>
        {toolName ? (
          <span className="font-mono rounded bg-white/70 px-1.5 py-0.5 dark:bg-slate-950/60">
            {toolName}
          </span>
        ) : null}
        <span className="rounded bg-white/70 px-1.5 py-0.5 dark:bg-slate-950/60">
          {result.ok ? 'Succeeded' : 'Failed'}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[11px] opacity-75">{result.callId}</span>
        {open ? (
          <ChevronDown className="h-3 w-3 flex-none" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-none" />
        )}
      </button>
      {open ? (
        <pre
          className={`border-t ${border} px-3 py-2 whitespace-pre-wrap overflow-x-auto text-slate-700 dark:text-slate-200`}
        >
          {result.content}
        </pre>
      ) : null}
    </div>
  )
}
