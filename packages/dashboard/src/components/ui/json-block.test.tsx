import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { JsonBlock } from './json-block.js'

describe('JsonBlock', () => {
  it('shows a compact value summary and local serialized search status', () => {
    render(<JsonBlock label="Payload" value={{ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }} />)

    expect(screen.getByText('Payload')).toBeTruthy()
    expect(screen.getByTestId('json-block-summary').textContent ?? '').toContain('object 2')

    fireEvent.change(screen.getByTestId('json-block-search'), { target: { value: 'role' } })
    expect(screen.getByTestId('json-block-search-status').textContent ?? '').toContain('1 text match')

    fireEvent.change(screen.getByTestId('json-block-search'), { target: { value: 'missing-key' } })
    expect(screen.getByTestId('json-block-search-status').textContent ?? '').toContain('No serialized JSON matches')
  })
})
