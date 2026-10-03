import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('opens rendered diagrams in the zoomable image viewer', async () => {
    render(<MermaidBlock code="flowchart LR\nA-->B" />)
    const diagram = await screen.findByRole('button', { name: 'Open Mermaid diagram' })
    fireEvent.click(diagram)
    expect(screen.getByTestId('mermaid-preview-dialog')).toBeTruthy()
    expect(screen.getByTestId('mermaid-preview-image').querySelector('svg')).toBeTruthy()
    expect(screen.getByTestId('mermaid-preview-dialog').querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeTruthy()
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
