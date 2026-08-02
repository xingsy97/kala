import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CompactFeedbackRow, formatTokensShort } from './InlineStatusRow.js'

describe('compact context display', () => {
  it('labels the value as current context rather than cumulative token usage', () => {
    render(<CompactFeedbackRow kind="running" startedAt={Date.now()} tokensBefore={823_456} />)
    expect(screen.getByTestId('inline-compact-running').textContent).toContain('context 823.5k tokens')
    expect(screen.getByTestId('inline-compact-running').textContent).not.toContain('↑')
  })

  it('formats only genuinely million-sized snapshots as millions', () => {
    expect(formatTokensShort(999_999)).toBe('1000.0k tokens')
    expect(formatTokensShort(1_100_000)).toBe('1.1m tokens')
  })
})
