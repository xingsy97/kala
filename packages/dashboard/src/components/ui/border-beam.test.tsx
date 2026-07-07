import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BorderBeam } from './border-beam.js'

describe('BorderBeam', () => {
  it('renders an aria-hidden decorative span', () => {
    render(<BorderBeam />)
    const beam = screen.getByTestId('border-beam')
    expect(beam.getAttribute('aria-hidden')).toBe('true')
    expect(beam.tagName).toBe('SPAN')
  })

  it('forwards size, duration, and colors as CSS custom properties', () => {
    render(<BorderBeam size={2} duration={6} colorFrom="red" colorTo="blue" />)
    const beam = screen.getByTestId('border-beam') as HTMLSpanElement
    expect(beam.style.getPropertyValue('--ak-beam-size')).toBe('2px')
    expect(beam.style.getPropertyValue('--ak-beam-duration')).toBe('6s')
    expect(beam.style.getPropertyValue('--ak-beam-color-from')).toBe('red')
    expect(beam.style.getPropertyValue('--ak-beam-color-to')).toBe('blue')
  })

  it('applies the ak-border-beam class so the global keyframes attach', () => {
    render(<BorderBeam />)
    expect(screen.getByTestId('border-beam').classList.contains('ak-border-beam')).toBe(true)
  })
})
