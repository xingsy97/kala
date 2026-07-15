import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createInitialState } from '@agent-kernel/kernel'

import { RuntimeMetrics } from './RuntimeMetrics.js'

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
        contextSnapshot={{
          estimatedMessageTokens: 1_000,
          estimatedToolSchemaTokens: 100,
          estimatedTotalInputTokens: 1_200,
          reserveTokens: 100,
          effectiveLimit: 4_000,
          pressureLevel: 'none',
          reasonCodes: [],
        }}
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
    expect(popover.textContent ?? '').toContain('Session Info')
    expect(popover.textContent ?? '').toContain('Context Window')
    expect(popover.textContent ?? '').toContain('Reserved for response')
    expect(popover.textContent ?? '').toContain('System Instructions')
    expect(popover.textContent ?? '').toContain('Tool Definitions')
    expect(popover.textContent ?? '').toContain('Messages')
    expect(popover.textContent ?? '').toContain('Tool Results')

    fireEvent.click(screen.getByTestId('context-compact-conversation'))
    expect(onCompact).toHaveBeenCalledTimes(1)
  })
})
