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
    <div className="flex flex-col gap-3 p-4">
      {messages.length === 0 ? (
        <div className="text-slate-500 text-sm">No messages yet.</div>
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
  const bg =
    message.role === 'user'
      ? 'bg-slate-100 dark:bg-slate-800'
      : message.role === 'assistant'
        ? 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700'
        : 'bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800'
  const label =
    message.role === 'user'
      ? 'you'
      : message.role === 'assistant'
        ? 'assistant'
        : message.role
  const ring = highlighted
    ? 'ring-2 ring-amber-400/70 shadow-lg shadow-amber-500/10'
    : ''
  return (
    <div
      id={`msg-${index}`}
      data-message-index={index}
      className={`rounded-md p-3 transition-shadow ${bg} ${ring}`}
    >
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
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
  return <ToolResultBlock result={content} />
}

function AssistantMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-slate-800 dark:text-slate-100 leading-relaxed [&_pre]:bg-slate-100 dark:[&_pre]:bg-slate-950 [&_pre]:border [&_pre]:border-slate-200 dark:[&_pre]:border-slate-800 [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto [&_code]:text-amber-700 dark:[&_code]:text-amber-200 [&_code]:bg-slate-100 dark:[&_code]:bg-slate-900 [&_code]:px-1 [&_code]:rounded [&_pre_code]:bg-transparent [&_pre_code]:text-slate-800 dark:[&_pre_code]:text-slate-100 [&_pre_code]:p-0 [&_a]:text-sky-600 dark:[&_a]:text-sky-400 [&_a]:underline [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:border [&_table]:border-slate-300 dark:[&_table]:border-slate-700 [&_th]:border [&_th]:border-slate-300 dark:[&_th]:border-slate-700 [&_th]:px-2 [&_td]:border [&_td]:border-slate-300 dark:[&_td]:border-slate-700 [&_td]:px-2 [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 dark:[&_blockquote]:border-slate-600 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600 dark:[&_blockquote]:text-slate-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function ToolCallBlock({ call }: { call: ToolCallContent }): JSX.Element {
  return (
    <div className="border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 rounded p-2 font-mono text-xs">
      <div className="text-amber-700 dark:text-amber-400">
         -  {call.name}{' '}
        <span className="text-slate-500 dark:text-slate-500">
          ({call.callId})
        </span>
      </div>
      <pre className="mt-1 text-amber-800 dark:text-amber-100/80 whitespace-pre-wrap">
        {JSON.stringify(call.input, null, 2)}
      </pre>
    </div>
  )
}

function ToolResultBlock({
  result,
}: {
  result: ToolResultContent
}): JSX.Element {
  const border = result.ok
    ? 'border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/40'
    : 'border-rose-300 dark:border-rose-800/60 bg-rose-50 dark:bg-rose-950/40'
  return (
    <div
      className={`border ${border} rounded p-2 font-mono text-xs whitespace-pre-wrap text-slate-700 dark:text-slate-200`}
    >
      <div
        className={
          result.ok
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-rose-700 dark:text-rose-400'
        }
      >
         -  {result.ok ? 'ok' : 'err'}{' '}
        <span className="text-slate-500 dark:text-slate-500">
          ({result.callId})
        </span>
      </div>
      <div className="mt-1">{result.content}</div>
    </div>
  )
}
