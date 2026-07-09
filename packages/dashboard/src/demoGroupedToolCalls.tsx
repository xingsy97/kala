import type { Message } from '@agent-kernel/kernel'

import { ChatPanel } from './features/chat/ChatPanel.js'

const READ_CALLS = [
  { path: 'src/foo.ts', lines: 200 },
  { path: 'src/bar.ts', lines: 78 },
  { path: 'src/baz.ts', lines: 412 },
  { path: 'src/qux.ts', lines: 23 },
  { path: 'src/quux.ts', lines: 155 },
]

const GREP_CALLS = [
  { pattern: 'TODO', path: 'src/', hits: 12 },
  { pattern: 'FIXME', path: 'src/', hits: 0 },
  { pattern: 'XXX', path: 'src/', hits: 4 },
]

const BASH_CALLS = [
  { command: 'pnpm test', ok: true },
  { command: 'pnpm build', ok: true },
  { command: 'pnpm lint', ok: false },
]

function makeReadMessages(): Message[] {
  const assistant: Message = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Reading the main source files.' },
      ...READ_CALLS.map((c, i) => ({
        type: 'tool_call' as const,
        callId: `read-${i}`,
        name: 'read',
        input: { file_path: c.path },
      })),
    ],
  }
  const tool: Message = {
    role: 'tool',
    content: READ_CALLS.map((c, i) => ({
      type: 'tool_result' as const,
      callId: `read-${i}`,
      ok: true,
      content: Array.from({ length: c.lines }, (_, k) => `${k + 1}\tline ${k + 1}`).join('\n'),
    })),
  }
  return [assistant, tool]
}

function makeGrepMessages(): Message[] {
  const assistant: Message = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Grepping for common markers.' },
      ...GREP_CALLS.map((c, i) => ({
        type: 'tool_call' as const,
        callId: `grep-${i}`,
        name: 'grep',
        input: { pattern: c.pattern, path: c.path },
      })),
    ],
  }
  const tool: Message = {
    role: 'tool',
    content: GREP_CALLS.map((c, i) => ({
      type: 'tool_result' as const,
      callId: `grep-${i}`,
      ok: true,
      content:
        c.hits === 0
          ? ''
          : Array.from({ length: c.hits }, (_, k) => `${c.path}file${k}.ts:${k + 1}:${c.pattern} something`).join('\n'),
    })),
  }
  return [assistant, tool]
}

function makeBashMessages(): Message[] {
  const assistant: Message = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running the project scripts.' },
      ...BASH_CALLS.map((c, i) => ({
        type: 'tool_call' as const,
        callId: `bash-${i}`,
        name: 'bash',
        input: { command: c.command },
      })),
    ],
  }
  const tool: Message = {
    role: 'tool',
    content: BASH_CALLS.map((c, i) => ({
      type: 'tool_result' as const,
      callId: `bash-${i}`,
      ok: c.ok,
      content: c.ok ? 'ok' : 'lint failed: 3 errors',
    })),
  }
  return [assistant, tool]
}

const DEMO_MESSAGES: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Read every source file, grep for markers, then run scripts.' }] },
  ...makeReadMessages(),
  ...makeGrepMessages(),
  ...makeBashMessages(),
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'All done. Reviewed 5 files, ran 3 greps, 3 scripts.' },
    ],
  },
]

export function GroupedToolCallsDemo(): JSX.Element {
  return (
    <div className="h-screen w-screen overflow-auto bg-background text-foreground">
      <ChatPanel messages={DEMO_MESSAGES} />
    </div>
  )
}
