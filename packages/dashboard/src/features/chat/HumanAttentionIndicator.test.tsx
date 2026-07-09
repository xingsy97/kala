import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { HumanAttentionTimeline } from '@agent-kernel/shared'

import { HumanAttentionIndicator, HumanAttentionLowBanner } from './HumanAttentionIndicator.js'

describe('HumanAttentionIndicator', () => {
  it('shows an empty attention state before evaluation points exist', () => {
    render(<HumanAttentionIndicator timeline={{ sessionId: 's1', points: [], latest: null }} />)

    const trigger = screen.getByTestId('human-attention-indicator')
    expect(trigger.textContent ?? '').toContain('--')
    fireEvent.click(trigger)
    expect(screen.getByTestId('human-attention-popover').textContent ?? '').toContain('No human messages have been evaluated yet.')
  })

  it('opens a session attention popover with timeline, dimensions, and reasons', () => {
    render(<HumanAttentionIndicator timeline={attentionTimeline()} />)

    const trigger = screen.getByTestId('human-attention-indicator')
    expect(trigger.textContent ?? '').toContain('82')
    expect(trigger.getAttribute('title') ?? '').toContain('Attention 82')

    fireEvent.click(trigger)

    const popover = screen.getByTestId('human-attention-popover')
    expect(popover.textContent ?? '').toContain('Human Attention')
    expect(popover.textContent ?? '').toContain('Engaged')
    expect(popover.textContent ?? '').toContain('Input')
    expect(popover.textContent ?? '').toContain('Risk exposure')
    expect(popover.textContent ?? '').toContain('Cursor 7')
    expect(screen.getByTestId('human-attention-chart')).toBeTruthy()
    // Reasons are collapsed by default; expand via the toggle button.
    expect(screen.queryByTestId('human-attention-reasons')).toBeNull()
    fireEvent.click(screen.getByTestId('human-attention-reasons-toggle'))
    expect(screen.getByTestId('human-attention-reasons').textContent ?? '').toContain('Recent human input includes specific intent or scope.')
  })

  it('renders the low-attention banner only when absent has risk or repeated delegation evidence', () => {
    const { rerender } = render(<HumanAttentionLowBanner timeline={attentionTimeline()} />)
    expect(screen.queryByTestId('human-attention-low-banner')).toBeNull()

    rerender(<HumanAttentionLowBanner timeline={attentionTimeline(18, 'absent')} />)
    expect(screen.queryByTestId('human-attention-low-banner')).toBeNull()

    rerender(<HumanAttentionLowBanner timeline={attentionTimeline(18, 'absent', 52)} />)
    expect(screen.getByTestId('human-attention-low-banner').textContent ?? '').toContain('Attention is low.')
  })

  it('stays dismissed while the agent keeps advancing without a new risk category', () => {
    // Initial low-attention snapshot: absent + mid-bucket risk (52).
    const { rerender } = render(
      <HumanAttentionLowBanner timeline={attentionTimeline(18, 'absent', 52)} />,
    )
    const banner = screen.getByTestId('human-attention-low-banner')
    fireEvent.click(screen.getByTestId('human-attention-low-banner-dismiss'))
    expect(screen.queryByTestId('human-attention-low-banner')).toBeNull()

    // Agent produces more messages: cursor advances, riskExposure wiggles
    // within the same bucket, reason kinds unchanged. Banner must stay hidden.
    rerender(
      <HumanAttentionLowBanner
        timeline={{
          ...attentionTimeline(18, 'absent', 55),
          latest: { ...point(11, 18, 'absent', 55) },
        }}
      />,
    )
    expect(screen.queryByTestId('human-attention-low-banner')).toBeNull()
    rerender(
      <HumanAttentionLowBanner
        timeline={{
          ...attentionTimeline(18, 'absent', 58),
          latest: { ...point(15, 18, 'absent', 58) },
        }}
      />,
    )
    expect(screen.queryByTestId('human-attention-low-banner')).toBeNull()

    // But if riskExposure crosses into a coarser bucket (mid → high at 60+),
    // the situation has escalated and the banner reappears.
    rerender(
      <HumanAttentionLowBanner
        timeline={{
          ...attentionTimeline(18, 'absent', 70),
          latest: { ...point(19, 18, 'absent', 70) },
        }}
      />,
    )
    expect(screen.getByTestId('human-attention-low-banner')).toBeTruthy()
    void banner
  })
})

function attentionTimeline(score = 82, level: HumanAttentionTimeline['latest']['level'] = 'engaged', riskExposure = 21): HumanAttentionTimeline {
  return {
    sessionId: 's1',
    points: [
      point(1, 48, 'drifting'),
      point(4, 66, 'watching'),
      point(7, score, level, riskExposure),
    ],
    latest: point(7, score, level, riskExposure),
  }
}

function point(cursor: number, score: number, level: NonNullable<HumanAttentionTimeline['latest']>['level'], riskExposure = 21): NonNullable<HumanAttentionTimeline['latest']> {
  return {
    sessionId: 's1',
    messageCursor: cursor,
    score,
    level,
    confidence: 0.72,
    dimensions: {
      inputQuality: 84,
      reviewDepth: 73,
      correctionQuality: 42,
      riskAwareness: 78,
      continuity: 58,
      riskExposure,
    },
    reasons: [
      {
        kind: 'specific_intent',
        severity: 'info',
        message: 'Recent human input includes specific intent or scope.',
      },
    ],
    evaluatedAt: '2026-07-23T00:00:00.000Z',
    evaluator: 'heuristic',
  }
}
