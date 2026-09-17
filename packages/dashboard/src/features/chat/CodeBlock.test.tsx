import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CodeBlock } from './CodeBlock.js'

vi.mock('../../lib/shiki.js', () => ({
  highlightToHtml: vi.fn(),
  SHIKI_LIGHT_THEME: 'github-light',
  SHIKI_DARK_THEME: 'github-dark',
}))

// Grab the mocked module handle after mock registration.
import * as shiki from '../../lib/shiki.js'

describe('CodeBlock', () => {
  beforeEach(() => {
    ;(shiki.highlightToHtml as ReturnType<typeof vi.fn>).mockReset()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders a plain <pre> when no language is provided (never calls shiki)', () => {
    render(<CodeBlock code="hello world" />)
    expect(screen.getByTestId('code-block-raw').querySelector('.ak-code-line-content')?.textContent).toBe('hello world')
    expect(shiki.highlightToHtml).not.toHaveBeenCalled()
  })

  it('enhances the existing pre node instead of remounting it', async () => {
    ;(shiki.highlightToHtml as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '<pre class="shiki"><code><span>const</span></code></pre>',
    )
    render(<CodeBlock code="const x = 1" lang="typescript" />)
    // Progressive: raw first…
    const pre = screen.getByTestId('code-block-raw')
    // …then enhances the same node once the promise resolves.
    await waitFor(() => expect(screen.getByTestId('code-block-highlighted')).toBe(pre))
    expect(screen.getByTestId('code-block-highlighted').getAttribute('data-lang')).toBe('typescript')
    expect(screen.getByTestId('code-block-language').textContent).toBe('TypeScript')
  })

  it('renders snippet chrome with line numbers and copy action', async () => {
    render(<CodeBlock code={'const a = 1\nconst b = 2'} lang="ts" />)
    expect(screen.getByTestId('code-snippet')).toBeTruthy()
    expect(screen.getByTestId('code-block-language').textContent).toBe('TypeScript')
    expect(screen.getAllByTestId('code-line-gutter').map((node) => node.textContent)).toEqual(['1', '2'])
    expect(screen.getAllByTestId('code-line').map((node) => node.querySelector('.ak-code-line-content')?.textContent)).toEqual(['const a = 1', 'const b = 2'])
    fireEvent.click(screen.getByTestId('code-block-copy'))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 1\nconst b = 2'))
    await screen.findByText('Copied')
  })

  it('keeps a streaming fence raw and does not invoke Shiki until complete', () => {
    render(<CodeBlock code="const x =" lang="typescript" deferEnhancement />)
    expect(screen.getByTestId('code-block-raw').querySelector('.ak-code-line-content')?.textContent).toBe('const x =')
    expect(shiki.highlightToHtml).not.toHaveBeenCalled()
  })

  it('falls back to <pre> when the highlighter returns null (unknown language)', async () => {
    ;(shiki.highlightToHtml as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    render(<CodeBlock code="???" lang="not-a-real-lang" />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('code-block-raw').querySelector('.ak-code-line-content')?.textContent).toBe('???')
  })
})
