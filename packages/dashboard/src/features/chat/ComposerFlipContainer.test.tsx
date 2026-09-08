import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ComposerFlipContainer } from './ComposerFlipContainer.js'

describe('ComposerFlipContainer', () => {
  it('shows the composer face when showApproval is false', () => {
    render(
      <ComposerFlipContainer
        showApproval={false}
        front={<div data-testid="front">composer</div>}
        back={<div data-testid="back">approval</div>}
      />,
    )
    const flip = screen.getByTestId('composer-flip')
    expect(flip.dataset.showing).toBe('composer')
    // Both faces stay mounted so a full turn animation can play.
    expect(screen.getByTestId('front').textContent).toBe('composer')
    expect(screen.getByTestId('back').textContent).toBe('approval')
  })

  it('shows the approval face when showApproval is true', () => {
    render(
      <ComposerFlipContainer
        showApproval
        front={<div data-testid="front">composer</div>}
        back={<div data-testid="back">approval</div>}
      />,
    )
    expect(screen.getByTestId('composer-flip').dataset.showing).toBe('approval')
  })

  it('marks the hidden face aria-hidden and its container inert', () => {
    const { rerender } = render(
      <ComposerFlipContainer
        showApproval={false}
        front={<div data-testid="front">composer</div>}
        back={<div data-testid="back">approval</div>}
      />,
    )
    const frontWrap = screen.getByTestId('front').parentElement!
    const backWrap = screen.getByTestId('back').parentElement!
    expect(frontWrap.getAttribute('aria-hidden')).toBe('false')
    expect(backWrap.getAttribute('aria-hidden')).toBe('true')
    expect(backWrap.hasAttribute('inert')).toBe(true)
    expect(frontWrap.hasAttribute('inert')).toBe(false)
    expect(frontWrap.className).toContain('pointer-events-auto')
    expect(backWrap.className).toContain('pointer-events-none')

    rerender(
      <ComposerFlipContainer
        showApproval
        front={<div data-testid="front">composer</div>}
        back={<div data-testid="back">approval</div>}
      />,
    )
    expect(frontWrap.getAttribute('aria-hidden')).toBe('true')
    expect(backWrap.getAttribute('aria-hidden')).toBe('false')
    expect(frontWrap.hasAttribute('inert')).toBe(true)
    expect(backWrap.hasAttribute('inert')).toBe(false)
    expect(frontWrap.className).toContain('pointer-events-none')
    expect(backWrap.className).toContain('pointer-events-auto')
  })
})
