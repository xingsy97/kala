import type { AgentState } from '@agent-kernel/kernel'
import { streamingMarkdownLlm } from '../fixtures/index.js'
import { waitMs } from '../probes/index.js'
import type { ScenarioContext, ScenarioResult } from './types.js'

const LONG_STREAM = Array.from({ length: 90 }, (_, index) => `## Streaming section ${index}\n\n${'Dynamic markdown content '.repeat(12)}\n`).join('\n')

export type StreamingScrollAnchorMetrics = {
  samples: number
  baselineScrollTop: number
  baselineDistanceFromBottom: number
  firstScrollTop: number
  lastScrollTop: number
  maxAnchorDriftPx: number
  maxScrollTopJumpPx: number
  returnedToBottom: boolean
}

export const STREAMING_SCROLL_ANCHOR_LLM = () => streamingMarkdownLlm({ markdown: LONG_STREAM, chunkChars: 18, chunkMs: 18 })

export async function runStreamingScrollAnchor(ctx: ScenarioContext): Promise<ScenarioResult<StreamingScrollAnchorMetrics>> {
  const { session, stack } = ctx
  // Seed a long, fully persisted transcript without spending model calls. The
  // browser then receives one real growing streaming row beneath that history.
  const record = stack.server.store.get(stack.sessionId)
  if (!record) throw new Error('perf session missing')
  for (let index = 0; index < 40; index++) {
    const userEvent = { kind: 'user_message' as const, text: `history-${index} ${'x'.repeat(180)}` }
    const { error: _priorError, ...baseState } = record.state
    const userState: AgentState = {
      ...baseState,
      cursor: record.state.cursor + 1,
      status: 'thinking' as const,
      pendingCalls: [],
      messages: [...record.state.messages, { role: 'user' as const, content: [{ type: 'text' as const, text: userEvent.text }] }],
    }
    await stack.server.store.record(stack.sessionId, userEvent, [], userState)
    const assistantMessage = { role: 'assistant' as const, content: [{ type: 'text' as const, text: `answer-${index} ${'y'.repeat(220)}` }] }
    const responseEvent = { kind: 'llm_response' as const, message: assistantMessage }
    const doneState: AgentState = { ...baseState, cursor: record.state.cursor + 1, status: 'done', pendingCalls: [], messages: [...record.state.messages, assistantMessage] }
    await stack.server.store.record(stack.sessionId, responseEvent, [], doneState)
  }
  // The app normalizes its address bar after selection, so reload() would lose
  // the cross-origin `host` bootstrap query. Re-open the canonical harness URL.
  await session.page.goto(stack.dashboardUrl, { waitUntil: 'networkidle2' })
  await session.waitForComposer()
  await session.sendPrompt('stream scroll-anchor test')
  await session.page.waitForSelector('.ak-streaming-tail, .ak-streaming-markdown', { timeout: 10_000 })

  const scroller = await session.page.waitForSelector('[data-virtuoso-scroller="true"]')
  if (!scroller) throw new Error('transcript scroller missing')
  const box = await scroller.boundingBox()
  if (!box) throw new Error('transcript scroller has no layout box')
  await session.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  // Real browser wheel input both establishes user intent and performs native
  // scrolling; dispatchEvent(WheelEvent) alone does not change scrollTop.
  for (let index = 0; index < 4; index++) {
    await session.page.mouse.wheel({ deltaY: -900 })
    await waitMs(50)
  }
  await waitMs(150)

  const baseline = await session.page.evaluate(() => {
    const scroller = document.querySelector('[data-virtuoso-scroller="true"]')!
    const rows = Array.from(document.querySelectorAll('[data-virt-index]'))
    const top = scroller.getBoundingClientRect().top
    const anchor = rows.find((row) => row.getBoundingClientRect().bottom > top + 4)
    const anchorIndex = anchor?.getAttribute('data-virt-index') ?? ''
    return { scrollTop: scroller.scrollTop, distanceFromBottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop, anchorIndex, top: anchor?.getBoundingClientRect().top ?? 0 }
  })

  const samples: Array<{ scrollTop: number; anchorTop: number; atBottom: boolean }> = []
  for (let index = 0; index < 50; index++) {
    samples.push(await session.page.evaluate((anchorIndex) => {
      const scroller = document.querySelector('[data-virtuoso-scroller="true"]')!
      const anchor = document.querySelector(`[data-virt-index="${anchorIndex}"]`)
      const distance = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
      return { scrollTop: scroller.scrollTop, anchorTop: anchor?.getBoundingClientRect().top ?? Number.NaN, atBottom: distance <= 8 }
    }, baseline.anchorIndex))
    await waitMs(80)
  }
  const finiteTops = samples.map((sample) => sample.anchorTop).filter(Number.isFinite)
  const maxAnchorDriftPx = finiteTops.length ? Math.max(...finiteTops.map((top) => Math.abs(top - baseline.top))) : Number.POSITIVE_INFINITY
  const maxScrollTopJumpPx = samples.reduce((max, sample, index) => index === 0 ? max : Math.max(max, Math.abs(sample.scrollTop - samples[index - 1]!.scrollTop)), 0)
  const returnedToBottom = samples.some((sample) => sample.atBottom)
  const metrics = { samples: samples.length, baselineScrollTop: baseline.scrollTop, baselineDistanceFromBottom: baseline.distanceFromBottom, firstScrollTop: samples[0]?.scrollTop ?? 0, lastScrollTop: samples.at(-1)?.scrollTop ?? 0, maxAnchorDriftPx, maxScrollTopJumpPx, returnedToBottom }
  return {
    name: 'streaming-scroll-anchor',
    reproduces: 'User scrolls upward while a live markdown row keeps growing; the viewport must remain anchored.',
    metrics,
    pass: !returnedToBottom && maxAnchorDriftPx <= 4 && maxScrollTopJumpPx <= 8,
    notes: `anchor drift ${maxAnchorDriftPx.toFixed(1)}px; max scrollTop jump ${maxScrollTopJumpPx.toFixed(1)}px; returnedToBottom=${returnedToBottom}`,
  }
}
