import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TaskGraphButton } from './TaskGraphButton.js'
import type { TaskGraphSnapshot } from './task-graph-from-timeline.js'

const graph: TaskGraphSnapshot = {
  version: 1,
  revision: 1,
  nodes: [
    { id: 'a', content: 'Audit', status: 'completed' },
    { id: 'b', content: 'Build', status: 'in_progress' },
    { id: 'c', content: 'Verify', status: 'pending' },
  ],
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  summary: { total: 3, completed: 1, active: 1, ready: 0, blocked: 1, cancelled: 0 },
  ready: [],
  blocked: [{ id: 'c', waitingOn: ['b'] }],
}

describe('TaskGraphButton responsive graph view', () => {
  it('uses a vertical graph in portrait tablet layout', () => {
    const original = window.matchMedia
    window.matchMedia = vi.fn((query: string) => ({ matches: query.includes('orientation: portrait'), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }))
    try {
      render(<TaskGraphButton graph={graph} />)
      fireEvent.click(screen.getByTestId('task-graph-trigger'))
      fireEvent.click(screen.getByText('Graph view'))
      expect(screen.getByTestId('task-graph-view').getAttribute('data-layout')).toBe('vertical')
      expect(screen.getByTestId('task-graph-popover').className).toContain('md:top-16')
    } finally {
      window.matchMedia = original
    }
  })
})
