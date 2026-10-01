import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'
import { COPILOT_RUNTIME_COMPACTION_POLICY, type ContextUsageSnapshot } from '@agent-kernel/shared'

import { RuntimeMetrics } from './RuntimeMetrics.js'

function contextSnapshot(inputTokens: number, contextWindow: number | null, source: ContextUsageSnapshot['contextWindow']['source'] = 'manual_config', modelRef = 'test-model'): ContextUsageSnapshot {
  return {
    model: { ref: modelRef, id: modelRef },
    contextWindow: { tokens: contextWindow, source },
    usage: { inputTokens, totalTokens: inputTokens },
    breakdown: {
      system: 100,
      transcript: Math.max(0, inputTokens - 200),
      tools: 100,
      memory: 0,
      attachments: 0,
      pendingUserInput: 0,
      transcriptBreakdown: {
        userMessages: 300,
        assistantMessages: 500,
        toolResults: Math.max(0, inputTokens - 200 - 800),
      },
    },
    estimator: {
      total: { kind: 'heuristic', confidence: 'rough' },
      breakdown: { kind: 'heuristic', confidence: 'rough' },
      version: 'test',
    },
    updatedAt: 0,
  }
}

describe('RuntimeMetrics', () => {
  it('shows a session info popover for context window usage', () => {
    const state = {
      ...createInitialState({ sessionId: 'sess-runtime' }),
      cursor: 12,
      pendingCalls: [
        {
          callId: 'c1',
          name: 'bash',
          input: { command: 'pwd' },
          status: 'pending_approval' as const,
        },
      ],
      usage: { inputTokens: 12_000, outputTokens: 34, cacheCreationTokens: 0, cacheReadTokens: 0 },
    }
    const onCompact = vi.fn()

    render(
      <RuntimeMetrics
        state={state}
        config={{ contextLimit: 4_000, hardThreshold: 0.8 }}
        contextSnapshot={contextSnapshot(1_200, 4_000)}
        modelInfo={{ id: 'gpt-test', label: 'gpt-test', provider: 'openai', contextWindow: 8_000 }}
        queuedMessages={2}
        timeline={[
          {
            seq: 1,
            ts: new Date().toISOString(),
            event: { kind: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
            effects: [
              {
                kind: 'call_llm',
                messages: [
                  { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
                  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                  { role: 'tool', content: [{ type: 'text', text: 'result' }] },
                ],
                tools: [{ name: 'bash', description: 'Run shell', inputSchema: {}, requiresApproval: true }],
              },
            ],
          },
        ]}
        onCompact={onCompact}
      />,
    )

    const indicator = screen.getByTestId('context-usage-indicator')
    expect(indicator.textContent ?? '').toContain('30%')
    expect(indicator.textContent ?? '').not.toContain('Events')
    expect(indicator.getAttribute('title') ?? '').toContain('Context window')

    fireEvent.click(indicator)
    const popover = screen.getByTestId('context-pressure-popover')
    // The popover focuses purely on context-window usage now — the generic
    // "Session Info" heading and the "Session Cost" row moved to the session
    // metadata dialog (this popover is not about cost).
    expect(popover.textContent ?? '').not.toContain('Session Info')
    expect(popover.textContent ?? '').not.toContain('Session Cost')
    expect(popover.textContent ?? '').toContain('Context Window')
    const totals = screen.getByTestId('context-usage-totals')
    expect(totals.textContent ?? '').toContain('Used1.2k')
    expect(totals.textContent ?? '').toContain('Limit4.0k')
    expect(totals.textContent ?? '').toContain('Remaining2.8k')
    // With stacked segments the legend now says "Reserved" (without the
    // "for response" tail) and lives inline with the other categories.
    expect(popover.textContent ?? '').toContain('Reserved')
    // Detailed token breakdown is collapsed by default; expand to verify rows.
    expect(screen.queryByTestId('context-breakdown-details')).toBeNull()
    fireEvent.click(screen.getByTestId('context-breakdown-toggle'))
    expect(popover.textContent ?? '').toContain('System / reserve')
    expect(popover.textContent ?? '').toContain('Tool Definitions')
    expect(popover.textContent ?? '').toContain('Messages')
    // Second-level split of the transcript by role.
    expect(popover.textContent ?? '').toContain('User messages')
    expect(popover.textContent ?? '').toContain('Assistant messages')
    expect(popover.textContent ?? '').toContain('Tool call results')
    expect(popover.textContent ?? '').toContain('Memory')

    fireEvent.click(screen.getByTestId('context-compact-conversation'))
    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('uses selected-model context from the context snapshot ahead of session config', () => {
    render(
      <RuntimeMetrics
        state={createInitialState({ sessionId: 'sess-opus' })}
        config={{ contextLimit: 400_000, hardThreshold: 0.8 }}
        contextSnapshot={contextSnapshot(2_000, 1_000_000, 'model_registry', 'claude-opus-4.7-1m-internal')}
        modelInfo={{ id: 'claude-opus-4.7-1m-internal', label: 'Opus 1M', provider: 'Anthropic', contextWindow: 1_000_000 }}
        queuedMessages={0}
      />,
    )

    const indicator = screen.getByTestId('context-usage-indicator')
    expect(indicator.getAttribute('title') ?? '').toContain('1.0M')
    expect(indicator.getAttribute('title') ?? '').not.toContain('400.0k')
    fireEvent.click(indicator)
    const popover = screen.getByTestId('context-pressure-popover')
    // Diagnostics (model context / source / estimator) now live under the
    // "Show token breakdown" collapse — they clutter the default view.
    expect(popover.textContent ?? '').not.toContain('Model context')
    expect(popover.textContent ?? '').not.toContain('model_registry')
    fireEvent.click(screen.getByTestId('context-breakdown-toggle'))
    expect(popover.textContent ?? '').toContain('Model context')
    expect(popover.textContent ?? '').toContain('1.0M')
    expect(popover.textContent ?? '').toContain('model_registry')
  })

  it('shows the effective runtime compaction authority and thresholds', () => {
    const current = contextSnapshot(207_200, 272_000, 'api_reported', 'gpt-5.6-sol')
    const started = contextSnapshot(217_800, 272_000, 'api_reported', 'gpt-5.6-sol')
    render(
      <RuntimeMetrics
        state={createInitialState({ sessionId: 'sess-copilot-policy' })}
        config={{ contextLimit: 272_000, hardThreshold: 0.92 }}
        contextSnapshot={current}
        runtimeCompactionPolicy={COPILOT_RUNTIME_COMPACTION_POLICY}
        compactStatus={{
          sessionId: 'sess-copilot-policy',
          kind: 'running',
          trigger: 'auto',
          tokensBefore: 217_800,
          attemptId: 'compact-1',
          startedAt: '2026-09-30T06:12:34.000Z',
          authority: 'runtime',
          scope: { kind: 'root' },
          startSnapshot: started,
        }}
        modelInfo={{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'GitHub Copilot', contextWindow: 272_000 }}
        queuedMessages={0}
      />,
    )

    fireEvent.click(screen.getByTestId('context-usage-indicator'))
    const policy = screen.getByTestId('context-compaction-policy')
    expect(policy.textContent ?? '').toContain('Agent runtime')
    expect(policy.textContent ?? '').toContain('Background compaction starts80%')
    expect(policy.textContent ?? '').toContain('Processing blocks at95%')
    expect(policy.textContent ?? '').toContain('Allowed')
    expect(policy.textContent ?? '').toContain('Runtime reported')
    const active = screen.getByTestId('context-active-compaction')
    expect(active.textContent ?? '').toContain('Running in background')
    expect(active.textContent ?? '').toContain('Started at217.8k / 272.0k (80%)')
    expect(active.textContent ?? '').toContain('Current snapshot207.2k / 272.0k (76%)')
  })

  it('does not fill an unknown host context window from client model info', () => {
    render(
      <RuntimeMetrics
        state={createInitialState({ sessionId: 'sess-unknown-context' })}
        config={{ contextLimit: 400_000, hardThreshold: 0.8 }}
        contextSnapshot={contextSnapshot(2_000, null, 'unknown', 'custom:model')}
        modelInfo={{ id: 'custom:model', label: 'Custom', provider: 'manual', contextWindow: 1_000_000 }}
        queuedMessages={0}
      />,
    )

    const indicator = screen.getByTestId('context-usage-indicator')
    expect(indicator.getAttribute('title') ?? '').toContain('unavailable')
    expect(indicator.getAttribute('title') ?? '').not.toContain('1.0M')
    fireEvent.click(indicator)
    const popover = screen.getByTestId('context-pressure-popover')
    expect(popover.textContent ?? '').toContain('unknown')
  })

  it('does not paint a colored endpoint before any context is used', () => {
    render(
      <RuntimeMetrics
        state={createInitialState({ sessionId: 'sess-empty-context' })}
        config={{ contextLimit: 4_000, hardThreshold: 0.8 }}
        contextSnapshot={contextSnapshot(0, 4_000)}
        modelInfo={{ id: 'gpt-test', label: 'gpt-test', provider: 'openai', contextWindow: 8_000 }}
        queuedMessages={0}
        density="simple"
      />,
    )

    expect(screen.getByTestId('context-usage-track').querySelector('[data-context-usage-tone]')).toBeNull()
    expect(screen.queryByTestId('context-usage-running-flow')).toBeNull()
  })

  it('marks active compute with a motion-safe flow while approval and idle remain static', () => {
    const base = createInitialState({ sessionId: 'sess-running-context' })
    const props = {
      config: { contextLimit: 4_000, hardThreshold: 0.8 },
      contextSnapshot: contextSnapshot(1_200, 4_000),
      modelInfo: { id: 'gpt-test', label: 'gpt-test', provider: 'openai', contextWindow: 8_000 },
      queuedMessages: 0,
      density: 'simple' as const,
    }
    const { rerender } = render(<RuntimeMetrics {...props} state={{ ...base, status: 'thinking', pendingCalls: [] }} />)
    expect(screen.getByTestId('context-usage-bar').getAttribute('data-running')).toBe('true')
    expect(screen.getByTestId('context-usage-track').getAttribute('data-running')).toBeNull()
    expect(screen.getByTestId('context-usage-fill').getAttribute('data-running')).toBe('true')
    expect(screen.getByTestId('context-usage-fill').getAttribute('stroke-dasharray')).toBe('30 71')
    expect(screen.getByTestId('context-usage-running-flow').getAttribute('class')).toContain('ak-context-usage-active-fill')
    expect(screen.getByTestId('context-usage-running-flow').getAttribute('stroke-dasharray')).toBe('5 11')
    expect(screen.getByTestId('context-usage-running-flow').getAttribute('mask')).toMatch(/^url\(#.+\)$/)

    rerender(<RuntimeMetrics {...props} state={{ ...base, status: 'awaiting_approval', pendingCalls: [{ callId: 'call-1', name: 'bash', input: {}, status: 'awaiting_approval' }] } as never} />)
    expect(screen.getByTestId('context-usage-bar').getAttribute('data-running')).toBe('false')
    expect(screen.queryByTestId('context-usage-running-flow')).toBeNull()

    rerender(<RuntimeMetrics {...props} state={base} />)
    expect(screen.getByTestId('context-usage-overlay').getAttribute('data-running')).toBe('false')
  })

  it('uses a full-width simple usage bar while keeping tooltip and popover details', () => {
    render(
      <RuntimeMetrics
        state={createInitialState({ sessionId: 'sess-simple' })}
        config={{ contextLimit: 4_000, hardThreshold: 0.8 }}
        contextSnapshot={contextSnapshot(1_200, 4_000)}
        modelInfo={{ id: 'gpt-test', label: 'gpt-test', provider: 'openai', contextWindow: 8_000 }}
        queuedMessages={0}
        density="simple"
      />,
    )

    const indicator = screen.getByTestId('context-usage-bar')
    const overlay = screen.getByTestId('context-usage-overlay')
    expect(overlay.className).toContain('absolute')
    expect(overlay.className).toContain('inset-0')
    expect(overlay.className).toContain('pointer-events-none')
    expect(screen.queryByTestId('context-usage-indicator')).toBeNull()
    expect(indicator.className).toContain('-inset-x-px')
    expect(indicator.className).toContain('h-5')
    expect(indicator.className).toContain('rounded-t-[22px]')
    expect(indicator.className).toContain('absolute')
    const track = screen.getByTestId('context-usage-track')
    expect(track.getAttribute('class') ?? '').toContain('inset-0')
    expect(track.getAttribute('class') ?? '').toContain('pointer-events-none')
    expect(track.getAttribute('data-running')).toBeNull()
    const paths = track.querySelectorAll(':scope > path')
    expect(paths[0]?.getAttribute('d')).toContain('Q')
    expect(paths[1]?.getAttribute('d')).toBe(paths[0]?.getAttribute('d'))
    const usage = screen.getByTestId('context-usage-fill')
    expect(usage?.getAttribute('data-context-usage-tone')).toBe('ok')
    expect(usage?.getAttribute('class')).toContain('stroke-sky-500/85')
    expect(usage?.getAttribute('class')).toContain('motion-reduce:transition-none')
    expect(usage?.getAttribute('stroke-dasharray')).toBe('30 71')
    expect(screen.queryByTestId('context-usage-simple-label')).toBeNull()
    expect(indicator.textContent ?? '').not.toContain('30%')
    expect(indicator.getAttribute('title') ?? '').toContain('30%')
    fireEvent.click(indicator)
    const anchoredPopover = screen.getByTestId('context-pressure-popover')
    expect(anchoredPopover.textContent ?? '').toContain('30%')
    expect(anchoredPopover.className).toContain('absolute')
    expect(anchoredPopover.className).toContain('pointer-events-auto')
    expect(anchoredPopover.className).toContain('bottom-full')
    expect(anchoredPopover.className).toContain('inset-x-0')
    expect(anchoredPopover.className).toContain('sm:left-auto')
    expect(anchoredPopover.className).toContain('mb-2')
    expect(anchoredPopover.className).not.toContain('fixed')
    expect(anchoredPopover.className).not.toContain('bottom-[5.5rem]')
  })

  it('keeps the active geometry clipped to the filled percentage', () => {
    render(
      <RuntimeMetrics
        state={{ ...createInitialState({ sessionId: 'sess-mode-switch' }), status: 'thinking' }}
        config={{ contextLimit: 4_000, hardThreshold: 0.8 }}
        contextSnapshot={contextSnapshot(1_400, 4_000)}
        modelInfo={{ id: 'gpt-test', label: 'gpt-test', provider: 'openai', contextWindow: 8_000 }}
        queuedMessages={0}
        density="simple"
      />,
    )
    expect(screen.getByTestId('context-usage-fill').getAttribute('stroke-dasharray')).toBe('35 66')
    expect(screen.getByTestId('context-usage-running-flow').getAttribute('mask')).toMatch(/^url\(#.+\)$/)
  })
})
