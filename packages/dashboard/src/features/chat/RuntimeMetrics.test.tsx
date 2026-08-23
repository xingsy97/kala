import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'
import type { ContextUsageSnapshot } from '@agent-kernel/shared'

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
    expect(track.querySelector('path')?.getAttribute('d')).toContain('Q')
    expect(track.querySelectorAll('[data-context-segment]')).toHaveLength(0)
    const usage = track.querySelector('[data-context-usage-tone]')
    expect(usage?.getAttribute('data-context-usage-tone')).toBe('ok')
    expect(usage?.getAttribute('stroke-linecap')).toBe('round')
    // No inline percentage number in the composer chrome...
    expect(indicator.textContent ?? '').not.toContain('%')
    // ...but the exact figure is still reachable via the tooltip and popover.
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
})
