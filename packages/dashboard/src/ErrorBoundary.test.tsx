import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ErrorBoundaryFallback } from './ErrorBoundary.js'

const { forcePwaRefresh } = vi.hoisted(() => ({ forcePwaRefresh: vi.fn(async () => {}) }))
vi.mock('./lib/pwa.js', () => ({ forcePwaRefresh }))

describe('Dashboard error boundary', () => {
  it('keeps internal render errors out of the default user-facing message', () => {
    render(<ErrorBoundaryFallback error={new Error("Cannot read properties of undefined (reading 'SecretComponent')")} />)
    expect(screen.getByText('The interface could not be loaded')).toBeTruthy()
    expect(screen.queryByText(/SecretComponent/u)).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeTruthy()
  })

  it('offers cache-clearing recovery when the interface cannot render', () => {
    render(<ErrorBoundaryFallback error={new Error('render failed')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Force refresh' }))
    expect(forcePwaRefresh).toHaveBeenCalledOnce()
  })
})
