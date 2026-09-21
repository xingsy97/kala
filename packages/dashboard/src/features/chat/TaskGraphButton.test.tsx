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
      const trigger = screen.getByTestId('task-graph-trigger')
      expect(trigger.textContent).toBe('')
      expect(trigger.getAttribute('aria-label')).toBe(trigger.getAttribute('title'))
      expect(trigger.getAttribute('aria-label') ?? '').toContain('1 completed')
      expect(trigger.getAttribute('aria-label') ?? '').toContain('0 ready')
      expect(trigger.className).toContain('h-11')
      expect(trigger.className).toContain('w-11')
      fireEvent.click(trigger)
      expect(screen.getByText('List view')).toBeTruthy()
      expect(screen.getByTestId('task-graph-view').getAttribute('data-layout')).toBe('vertical')
      const popover = screen.getByTestId('task-graph-popover')
      expect(popover.className).toContain('h-[min(76dvh,42rem)]')
      expect(popover.className).toContain('z-[70]')
      expect(popover.className).toContain('text-popover-foreground')
      expect(screen.getByText('Audit')).toBeTruthy()
      expect(screen.getByText('Build')).toBeTruthy()
      expect(screen.getByText('Verify')).toBeTruthy()
    } finally {
      window.matchMedia = original
    }
  })
})
