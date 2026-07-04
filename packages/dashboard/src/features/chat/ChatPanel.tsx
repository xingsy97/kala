import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'

type Props = {
  messages: readonly Message[]
}

export function ChatPanel({ messages }: Props): JSX.Element {
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-4">
      {messages.length === 0 ? (
        <div className="text-slate-500 text-sm">No messages yet.</div>
      ) : null}
      {messages.map((m, i) => (
        <MessageRow key={i} message={m} />
      ))}
    </div>
  )
}

function MessageRow({ message }: { message: Message }): JSX.Element {
  const bg =
    message.role === 'user'
      ? 'bg-slate-800'
      : message.role === 'assistant'
        ? 'bg-slate-900 border border-slate-700'
        : 'bg-slate-900/50 border border-slate-800'
  const label =
    message.role === 'user'
      ? 'you'
      : message.role === 'assistant'
        ? 'assistant'
        : message.role
  return (
    <div className={`rounded-md p-3 ${bg}`}>
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
        {label}
      </div>
      <div className="flex flex-col gap-2">
        {message.content.map((c, i) => (
          <ContentBlock key={i} content={c} />
        ))}
      </div>
    </div>
  )
}

function ContentBlock({ content }: { content: MessageContent }): JSX.Element {
  if (content.type === 'text') {
    return (
      <div className="whitespace-pre-wrap text-sm text-slate-100">
        {content.text}
      </div>
    )
  }
  if (content.type === 'tool_call') return <ToolCallBlock call={content} />
  return <ToolResultBlock result={content} />
}

function ToolCallBlock({ call }: { call: ToolCallContent }): JSX.Element {
  return (
    <div className="border border-amber-800/60 bg-amber-950/40 rounded p-2 font-mono text-xs">
      <div className="text-amber-400">
         -  {call.name} <span className="text-slate-500">({call.callId})</span>
      </div>
      <pre className="mt-1 text-amber-100/80 whitespace-pre-wrap">
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
    ? 'border-emerald-800/60 bg-emerald-950/40'
    : 'border-rose-800/60 bg-rose-950/40'
  return (
    <div
      className={`border ${border} rounded p-2 font-mono text-xs whitespace-pre-wrap text-slate-200`}
    >
      <div className={result.ok ? 'text-emerald-400' : 'text-rose-400'}>
         -  {result.ok ? 'ok' : 'err'}{' '}
        <span className="text-slate-500">({result.callId})</span>
      </div>
      <div className="mt-1">{result.content}</div>
    </div>
  )
}
