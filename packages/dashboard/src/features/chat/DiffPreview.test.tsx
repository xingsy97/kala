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

  it('shows write_file metadata and content preview', () => {
    render(<DiffPreview toolName="write_file" input={{ path: 'src/new.ts', content: 'export const value = 1' }} />)

    const header = screen.getByTestId('diff-preview-header')
    expect(header.textContent ?? '').toContain('src/new.ts')
    expect(header.textContent ?? '').toContain('write_file')
    expect(screen.getByText(/export const value = 1/)).toBeTruthy()
  })

  it('shows replace_in_file as an edit diff', () => {
    render(<DiffPreview toolName="replace_in_file" input={{ path: 'src/app.ts', old_string: 'old', new_string: 'new' }} />)

    const header = screen.getByTestId('diff-preview-header')
    expect(header.textContent ?? '').toContain('src/app.ts')
    expect(header.textContent ?? '').toContain('replace_in_file')
    expect(screen.getByText('old')).toBeTruthy()
    expect(screen.getByText('new')).toBeTruthy()
  })

  it('shows replace_many_in_file edit count and per-edit diff', () => {
    render(<DiffPreview toolName="replace_many_in_file" input={{ path: 'src/app.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd', replace_all: true }] }} />)

    const header = screen.getByTestId('diff-preview-header')
    expect(header.textContent ?? '').toContain('src/app.ts')
    expect(header.textContent ?? '').toContain('2 edits')
    expect(screen.getByText(/edit 2 · replace_all/)).toBeTruthy()
  })

  it('shows apply_file_patch patch preview', () => {
    render(<DiffPreview toolName="apply_file_patch" input={{ patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch' }} />)

    const header = screen.getByTestId('diff-preview-header')
    expect(header.textContent ?? '').toContain('src/app.ts')
    expect(header.textContent ?? '').toContain('apply_file_patch')
    expect(screen.getByText('+new')).toBeTruthy()
  })
})
