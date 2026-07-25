import type { LLMAdapter, LLMResponse } from '@agent-kernel/host'

/** The parameter object passed to an {@link LLMAdapter}'s `call`. */
type LLMCallParams = Parameters<LLMAdapter['call']>[0]

/**
 * Programmable scripted LLM adapters that generate specific front-end load
 * shapes, so scenarios can reproduce rendering/perf problems deterministically
 * without a real provider or API key.
 *
 * Each factory returns a plain {@link LLMAdapter}; the host swaps it in exactly
 * like a real provider.
 */

export type ToolLoopOptions = {
  /** Tool to call each turn. Must exist in the session's tool config. */
  toolName?: string
  /** How many tool-call turns before the agent finishes with text. */
  turns?: number
  /** Per-turn "thinking" delay (ms) so the thinking→executing_tools flip is observable. */
  thinkMs?: number
  /**
   * Size (chars) of a synthetic payload attached to each turn's assistant text
   * AND tool-call input. Big payloads reproduce the O(n·size) work that showed
   * up in the human-attention hot spot.
   */
  payloadChars?: number
}

/**
 * A tool-heavy turn: the agent emits `turns` tool calls back-to-back, flipping
 * between thinking and executing_tools many times. This is the shape used to
 * reproduce the sidebar/title status-indicator jank.
 */
export function toolLoopLlm(options: ToolLoopOptions = {}): LLMAdapter {
  const toolName = options.toolName ?? 'write'
  const turns = options.turns ?? 40
  const thinkMs = options.thinkMs ?? 300
  const payloadChars = options.payloadChars ?? 0
  const payload = payloadChars > 0 ? 'lorem ipsum dolor sit amet '.repeat(Math.ceil(payloadChars / 27)).slice(0, payloadChars) : ''
  let turn = 0
  return {
    name: 'perf-harness:tool-loop',
    async call(params: LLMCallParams): Promise<LLMResponse> {
      turn += 1
      if (thinkMs > 0) await delay(thinkMs, params.signal)
      if (turn <= turns) {
        const content = payload || `step ${turn}`
        return {
          message: {
            role: 'assistant',
            content: [
              ...(payload ? [{ type: 'text' as const, text: `Reasoning step ${turn}: ${payload}` }] : []),
              { type: 'tool_call' as const, callId: `perf-${turn}`, name: toolName, input: { path: `f${turn}.txt`, content } },
            ],
          },
        }
      }
      return { message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } }
    },
  }
}

export type StreamingMarkdownOptions = {
  /** Markdown document to stream. Defaults to a rich sample (headings/list/code/table/math). */
  markdown?: string
  /** Chars emitted per delta chunk. */
  chunkChars?: number
  /** Delay between chunks (ms). */
  chunkMs?: number
}

/**
 * Streams a markdown document token-by-token via `onTextDelta`, then returns it
 * as the final message. Used to reproduce streaming-markdown flicker (earlier
 * blocks rebuilding on every token).
 */
export function streamingMarkdownLlm(options: StreamingMarkdownOptions = {}): LLMAdapter {
  const markdown = options.markdown ?? RICH_MARKDOWN_SAMPLE
  const chunkChars = options.chunkChars ?? 4
  const chunkMs = options.chunkMs ?? 20
  return {
    name: 'perf-harness:streaming-markdown',
    async call(params: LLMCallParams): Promise<LLMResponse> {
      const chunks = markdown.match(new RegExp(`.{1,${chunkChars}}`, 'gs')) ?? [markdown]
      for (const chunk of chunks) {
        if (params.signal?.aborted) break
        params.onTextDelta?.(chunk)
        await delay(chunkMs, params.signal)
      }
      return { message: { role: 'assistant', content: [{ type: 'text', text: markdown }] } }
    },
  }
}

/** A single scripted response (no streaming, no tools) — useful as a baseline. */
export function replyOnceLlm(text = 'ok'): LLMAdapter {
  return {
    name: 'perf-harness:reply-once',
    async call(): Promise<LLMResponse> {
      return { message: { role: 'assistant', content: [{ type: 'text', text }] } }
    },
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** A rich markdown doc that exercises headings, lists, a fenced code block, a table and math. */
export const RICH_MARKDOWN_SAMPLE = `# Streaming markdown test

Here is a paragraph with **bold** and *italic* and \`inline code\`, plus a [link](https://example.com).

## A list
- first item with some detail
- second item that is a bit longer to exercise wrapping and reflow
- third item

## A code block
\`\`\`ts
function add(a: number, b: number): number {
  return a + b
}
const result = add(2, 3)
console.log(result)
\`\`\`

## A table
| name | value |
|------|-------|
| alpha | 1 |
| beta | 2 |

Some math: $E = mc^2$.

Final paragraph after everything, to confirm earlier blocks stay stable while this streams in.`
