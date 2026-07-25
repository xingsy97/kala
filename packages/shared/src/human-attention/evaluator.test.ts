import { describe, expect, it } from 'vitest'
import type { AgentEvent, Effect, Message } from '@agent-kernel/kernel'

import { buildHumanAttentionTimeline } from './evaluator.js'
import type { HumanAttentionTimelineEntry } from './types.js'

describe('human attention evaluator', () => {
  it('keeps high-quality attention strong during risky work', () => {
    const timeline = buildHumanAttentionTimeline('s1', [
      user(1, '检查 logging 问题，范围包括 host/executor，不要部署，先审计。'),
      assistantToolCalls(2, ['rg', 'sed']),
      toolResult(3, 'ok'),
      user(8, '你刚才只看了 dashboard，继续查 executor raw stdout。'),
      assistantToolCalls(9, ['apply_patch']),
      toolResult(10, 'patched'),
      user(15, '修复前先确认不会影响 structured logger 和 importance 输出。'),
    ], fixedNow())

    expect(timeline.latest?.score).toBeGreaterThanOrEqual(70)
    expect(timeline.latest?.level).toMatch(/engaged|watching/)
    expect(timeline.latest?.reasons.some((reason) => reason.kind === 'corrected_agent_assumption')).toBe(true)
  })

  it('drops for continue-only delegation during broad edits', () => {
    const entries: HumanAttentionTimelineEntry[] = [user(1, '做一下。')]
    for (let i = 2; i <= 22; i += 2) {
      entries.push(assistantToolCalls(i, ['apply_patch', 'bash']))
      entries.push(toolResult(i + 1, 'ok'))
    }
    entries.push(user(30, '继续'))
    entries.push(assistantToolCalls(31, ['apply_patch', 'git']))
    entries.push(toolResult(32, 'ok'))
    entries.push(user(40, 'continue'))
    entries.push(assistantToolCalls(41, ['deploy']))

    const timeline = buildHumanAttentionTimeline('s1', entries, fixedNow())

    expect(timeline.latest?.score).toBeLessThan(30)
    expect(timeline.latest?.level).toBe('absent')
    expect(timeline.latest?.reasons.some((reason) => reason.kind === 'continue_only')).toBe(true)
    expect(timeline.latest?.reasons.some((reason) => reason.kind === 'high_agent_activity')).toBe(true)
  })

  it('does not panic during read-only audit without edits', () => {
    const entries: HumanAttentionTimelineEntry[] = [user(1, '审计 schema 冗余字段，先不要改，给证据和修改计划。')]
    for (let i = 2; i <= 18; i += 2) {
      entries.push(assistantToolCalls(i, ['rg', 'sed']))
      entries.push(toolResult(i + 1, 'read'))
    }
    const timeline = buildHumanAttentionTimeline('s1', entries, fixedNow())

    expect(timeline.latest?.score).toBeGreaterThanOrEqual(45)
    expect(timeline.latest?.level).not.toBe('absent')
  })

  it('treats fresh low-risk exploration as drifting instead of absent', () => {
    const timeline = buildHumanAttentionTimeline('s1', [
      user(1, '看一下当前项目是什么'),
      assistantToolCalls(2, ['pwd', 'ls', 'rg']),
      toolResult(3, 'read'),
    ], fixedNow())

    expect(timeline.latest?.level).not.toBe('absent')
    expect(timeline.latest?.score).toBeGreaterThanOrEqual(30)
    expect(timeline.latest?.dimensions.riskExposure).toBeLessThan(10)
  })

  it('does not alarm on one low-risk continue during read-only exploration', () => {
    const timeline = buildHumanAttentionTimeline('s1', [
      user(1, '先看一下这个项目结构'),
      assistantToolCalls(2, ['pwd', 'ls', 'rg']),
      toolResult(3, 'read'),
      user(4, '继续'),
      assistantToolCalls(5, ['rg', 'sed']),
      toolResult(6, 'read'),
    ], fixedNow())

    expect(timeline.latest?.score).toBeGreaterThanOrEqual(30)
    expect(timeline.latest?.level).not.toBe('absent')
  })

  it('lets the low-risk floor expire after extended activity without fresh human input', () => {
    const entries: HumanAttentionTimelineEntry[] = [user(1, '看一下当前项目是什么')]
    for (let seq = 2; seq <= 18; seq += 2) {
      entries.push(assistantToolCalls(seq, ['rg', 'sed']))
      entries.push(toolResult(seq + 1, 'read'))
    }

    const timeline = buildHumanAttentionTimeline('s1', entries, fixedNow())

    expect(timeline.latest?.reasons.some((reason) => reason.kind === 'stale_review')).toBe(false)
    expect(timeline.latest?.level).not.toBe('engaged')
  })

  it('does not apply the low-risk floor to high-risk edits after a broad prompt', () => {
    const timeline = buildHumanAttentionTimeline('s1', [
      user(1, '做一下这个功能'),
      assistantToolCalls(2, ['apply_patch', 'git', 'deploy']),
    ], fixedNow())

    expect(timeline.latest?.dimensions.riskExposure).toBeGreaterThanOrEqual(30)
    expect(timeline.latest?.score).toBeLessThan(38)
  })

  it('recovers quickly after a specific correction', () => {
    const timeline = buildHumanAttentionTimeline('s1', [
      user(1, '继续'),
      assistantToolCalls(2, ['apply_patch']),
      toolResult(3, 'ok'),
      user(4, '不对，你隐藏了 restart 问题，不是解决了问题。应该自动 restart；如果有 running session 要 double confirm。'),
    ], fixedNow())

    expect(timeline.latest?.score).toBeGreaterThanOrEqual(60)
    expect(timeline.latest?.dimensions.correctionQuality).toBeGreaterThanOrEqual(60)
  })

  it('still flags high risk for a huge tool input (keyword up front) without stringifying the whole blob', () => {
    // A tool whose risk keyword ("deploy") is at the front but whose input also
    // carries a multi-KB content blob. Risk must still register, and the
    // evaluation must not depend on serializing the whole payload (regression:
    // JSON.stringify of large inputs was a main-thread hot spot).
    const bigContent = 'x'.repeat(200_000)
    const riskyBig: HumanAttentionTimelineEntry = {
      seq: 2,
      ts: '2026-07-23T00:00:02.000Z',
      event: { kind: 'llm_response', message: { role: 'assistant', content: [{ type: 'tool_call', callId: 'c2', name: 'bash', input: { command: 'deploy prod', content: bigContent } }] } },
      effects: [{ kind: 'call_tool', callId: 'c2', name: 'bash', input: { command: 'deploy prod', content: bigContent } }],
    }
    const started = Date.now()
    const timeline = buildHumanAttentionTimeline('s1', [user(1, '做一下。'), riskyBig], fixedNow())
    const elapsed = Date.now() - started
    // Risk exposure should be non-trivial (deploy => very-high weight), and the
    // whole evaluation should be fast even with a 200KB payload.
    expect(timeline.latest?.dimensions.riskExposure ?? 0).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(150)
  })
})

function fixedNow() {
  return { now: () => '2026-07-23T00:00:00.000Z' }
}

function user(seq: number, text: string): HumanAttentionTimelineEntry {
  return { seq, ts: `2026-07-23T00:00:${String(seq).padStart(2, '0')}.000Z`, event: { kind: 'user_message', text } }
}

function assistantToolCalls(seq: number, names: readonly string[]): HumanAttentionTimelineEntry {
  const message: Message = {
    role: 'assistant',
    content: names.map((name, index) => ({ type: 'tool_call' as const, callId: `c${seq}-${index}`, name, input: { command: name === 'bash' ? 'pnpm test' : name } })),
  }
  const effects: Effect[] = names.map((name, index) => ({ kind: 'call_tool', callId: `c${seq}-${index}`, name, input: { command: name } }))
  return { seq, ts: `2026-07-23T00:00:${String(seq).padStart(2, '0')}.000Z`, event: { kind: 'llm_response', message }, effects }
}

function toolResult(seq: number, content: string): HumanAttentionTimelineEntry {
  return { seq, ts: `2026-07-23T00:00:${String(seq).padStart(2, '0')}.000Z`, event: { kind: 'tool_result', callId: `c${seq}`, ok: true, content } }
}
