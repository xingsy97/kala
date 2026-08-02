import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProductState } from './product-state.js'

describe('ProductState', () => {
  it('presents actionable errors without pretending to load', () => {
    const retry = vi.fn()
    render(<ProductState kind="error" title="Workspace unavailable" description="Your draft is safe." primary={{ label: 'Retry', onClick: retry }} />)
    expect(screen.getByRole('alert').getAttribute('data-product-state')).toBe('error')
    expect(screen.getByText('Your draft is safe.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('uses a polite status for named loading work', () => {
    render(<ProductState kind="loading" title="Connecting workspace" description="Waiting for the Executor to come online." />)
    expect(screen.getByRole('status').textContent).toContain('Connecting workspace')
  })
})
