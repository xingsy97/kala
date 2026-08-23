import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ErrorBoundaryFallback } from './ErrorBoundary.js'

describe('Dashboard error boundary', () => {
  it('keeps internal render errors out of the default user-facing message', () => {
    render(<ErrorBoundaryFallback error={new Error("Cannot read properties of undefined (reading 'SecretComponent')")} />)
    expect(screen.getByText('The interface could not be loaded')).toBeTruthy()
    expect(screen.queryByText(/SecretComponent/u)).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeTruthy()
  })
})
