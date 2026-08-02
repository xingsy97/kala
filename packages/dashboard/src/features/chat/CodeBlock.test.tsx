import { act, render, screen, waitFor } from '@testing-library/react'
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
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders a plain <pre> when no language is provided (never calls shiki)', () => {
    render(<CodeBlock code="hello world" />)
    expect(screen.getByTestId('code-block-raw').textContent).toBe('hello world')
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
  })

  it('keeps a streaming fence raw and does not invoke Shiki until complete', () => {
    render(<CodeBlock code="const x =" lang="typescript" deferEnhancement />)
    expect(screen.getByTestId('code-block-raw').textContent).toBe('const x =')
    expect(shiki.highlightToHtml).not.toHaveBeenCalled()
  })

  it('falls back to <pre> when the highlighter returns null (unknown language)', async () => {
    ;(shiki.highlightToHtml as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    render(<CodeBlock code="???" lang="not-a-real-lang" />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('code-block-raw').textContent).toBe('???')
  })
})
