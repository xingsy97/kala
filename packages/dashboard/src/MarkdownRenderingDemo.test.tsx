import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarkdownRenderingDemo } from './MarkdownRenderingDemo.js'

describe('MarkdownRenderingDemo parity fixture', () => {
  it('renders the same semantic Chinese Markdown fixture for browser engines', () => {
    const { container } = render(<MarkdownRenderingDemo />)

    expect(screen.getByTestId('markdown-rendering-fixture')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '中文 Markdown 标题' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '正在生成' })).toBeTruthy()
    expect(container.querySelectorAll('strong')).toHaveLength(3)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Message table' }).hasAttribute('tabindex')).toBe(false)
    expect(container.textContent).not.toContain('**')
    expect(container.textContent).not.toMatch(/[\uFEFF\uE000\uE001]/u)
  })
})
