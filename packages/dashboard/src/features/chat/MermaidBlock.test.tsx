import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MermaidBlock } from './MermaidBlock.js'

const renderDiagram = vi.fn()
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: renderDiagram,
  },
}))

describe('MermaidBlock', () => {
  beforeEach(() => {
    renderDiagram.mockReset().mockImplementation(async (_id: string, code: string) => {
      if (code === 'not a graph') throw new Error('parse')
      return { svg: '<svg viewBox="0 0 10 10"><path /></svg>' }
    })
  })

  it('renders SVG for a completed Mermaid fence', async () => {
    render(<MermaidBlock code="flowchart LR\nA-->B" />)
    expect(screen.getByTestId('code-block-raw')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('mermaid-diagram').querySelector('svg')).toBeTruthy())
  })

  it('does not repeatedly render an incomplete streaming diagram', () => {
    render(<MermaidBlock code="flowchart LR\nA--" deferRender />)
    expect(screen.getByTestId('code-block-raw').textContent).toContain('flowchart LR')
    expect(renderDiagram).not.toHaveBeenCalled()
  })

  it('falls back to source when Mermaid rejects invalid syntax', async () => {
    render(<MermaidBlock code="not a graph" />)
    await waitFor(() => expect(screen.getByTestId('mermaid-error')).toBeTruthy())
    expect(screen.getByTestId('code-block-raw').textContent).toContain('not a graph')
  })
})
