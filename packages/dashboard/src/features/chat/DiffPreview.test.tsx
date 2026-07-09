import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DiffPreview } from './DiffPreview.js'

describe('DiffPreview', () => {
  it('shows edit file metadata, changed counts, and collapsible unchanged gaps', () => {
    render(
      <DiffPreview
        toolName="edit"
        input={{
          file_path: 'src/app.ts',
          old_string: ['a', 'b', 'c', 'd', 'e', 'f', 'old'].join('\n'),
          new_string: ['a', 'b', 'c', 'd', 'e', 'f', 'new'].join('\n'),
        }}
      />,
    )

    const header = screen.getByTestId('diff-preview-header')
    expect(header.textContent ?? '').toContain('src/app.ts')
    expect(header.textContent ?? '').toContain('modified')
    expect(header.textContent ?? '').toContain('+1')
    expect(header.textContent ?? '').toContain('-1')

    fireEvent.click(screen.getByTestId('diff-gap-toggle'))
    expect(screen.getByText(/Collapsed unchanged context/)).toBeTruthy()
  })

  it('shows write metadata for file_path inputs', () => {
    render(<DiffPreview toolName="write" input={{ file_path: 'src/new.ts', content: 'export const value = 1' }} />)

    const header = screen.getByTestId('diff-preview-header')
    expect(header.textContent ?? '').toContain('src/new.ts')
    expect(header.textContent ?? '').toContain('created/overwrite')
    expect(header.textContent ?? '').toContain('write')
  })
})
