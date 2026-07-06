import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TodoItem } from '@agent-kernel/kernel'

import { TasksPeek } from './TasksPeek.js'

function makeTodos(
  spec: ReadonlyArray<[string, TodoItem['status']]>,
): readonly TodoItem[] {
  return spec.map(([content, status]) => ({ content, status }))
}

const PEEK_MS = 50
const TICK_MS = 200
// Must be >= EXIT_MS in TasksPeek.tsx so tests advance past the exit animation
// and see the panel actually unmount.
const EXIT_MS = 200

describe('TasksPeek', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing when the todo list is empty', () => {
    const { container } = render(<TasksPeek todos={[]} peekMs={PEEK_MS} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders collapsed by default on first render even with pre-populated todos', () => {
    const todos = makeTodos([['first', 'in_progress']])
    render(<TasksPeek todos={todos} peekMs={PEEK_MS} />)
    const wrap = screen.getByTestId('tasks-peek')
    expect(wrap.dataset.mode).toBe('collapsed')
    expect(screen.queryByTestId('tasks-peek-panel')).toBeNull()
    expect(screen.getByTestId('tasks-peek-toggle').getAttribute('aria-expanded')).toBe('false')
  })

  it('auto-expands when the todos reference changes, then auto-collapses after peekMs', () => {
    const initial = makeTodos([['a', 'pending']])
    const { rerender } = render(<TasksPeek todos={initial} peekMs={PEEK_MS} />)
    const next = makeTodos([['a', 'in_progress']])
    rerender(<TasksPeek todos={next} peekMs={PEEK_MS} />)

    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('peek')
    expect(screen.queryByTestId('tasks-peek-panel')).not.toBeNull()

    // Advance past peek window + one tick to trigger the collapse.
    act(() => {
      vi.advanceTimersByTime(PEEK_MS + TICK_MS + 10)
    })
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('collapsed')

    // Panel stays mounted for the exit animation. Advance past EXIT_MS to
    // see it actually unmount. Split into a second act() so the effect that
    // schedules the unmount runs before we advance timers.
    act(() => {
      vi.advanceTimersByTime(EXIT_MS + 10)
    })
    expect(screen.queryByTestId('tasks-peek-panel')).toBeNull()
  })

  it('does not auto-expand when only the todos array identity changes', () => {
    const initial = makeTodos([['a', 'pending']])
    const { rerender } = render(<TasksPeek todos={initial} peekMs={PEEK_MS} />)

    rerender(<TasksPeek todos={makeTodos([['a', 'pending']])} peekMs={PEEK_MS} />)

    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('collapsed')
    expect(screen.queryByTestId('tasks-peek-panel')).toBeNull()
  })

  it('sliding window: a second change during peek pushes the expiry forward', () => {
    const t0 = makeTodos([['a', 'pending']])
    const { rerender } = render(<TasksPeek todos={t0} peekMs={PEEK_MS} />)
    const t1 = makeTodos([['a', 'in_progress']])
    rerender(<TasksPeek todos={t1} peekMs={PEEK_MS} />)

    // Halfway through the peek window a new change fires.
    act(() => {
      vi.advanceTimersByTime(PEEK_MS / 2)
    })
    const t2 = makeTodos([['a', 'in_progress'], ['b', 'pending']])
    rerender(<TasksPeek todos={t2} peekMs={PEEK_MS} />)

    // Original expiry would have been at t=PEEK_MS. We're now at t=PEEK_MS/2
    // with a refreshed expiry at t=PEEK_MS + PEEK_MS/2. Push past the ORIGINAL
    // expiry but not the refreshed one: still peeking.
    act(() => {
      vi.advanceTimersByTime(PEEK_MS / 2 + 5)
    })
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('peek')

    // Advance past the refreshed expiry + a tick: collapses.
    act(() => {
      vi.advanceTimersByTime(PEEK_MS + TICK_MS + 10)
    })
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('collapsed')
  })

  it('manual click on the pill enters sticky and ignores auto-collapse', () => {
    const todos = makeTodos([['a', 'pending']])
    render(<TasksPeek todos={todos} peekMs={PEEK_MS} />)
    fireEvent.click(screen.getByTestId('tasks-peek-toggle'))
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('sticky')

    // Even a long wait should not close a sticky panel.
    act(() => {
      vi.advanceTimersByTime(PEEK_MS * 10 + TICK_MS)
    })
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('sticky')
    expect(screen.queryByTestId('tasks-peek-panel')).not.toBeNull()
  })

  it('todos change while sticky does not disturb the sticky mode', () => {
    const t0 = makeTodos([['a', 'pending']])
    const { rerender } = render(<TasksPeek todos={t0} peekMs={PEEK_MS} />)
    fireEvent.click(screen.getByTestId('tasks-peek-toggle'))
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('sticky')
    const t1 = makeTodos([['a', 'completed']])
    rerender(<TasksPeek todos={t1} peekMs={PEEK_MS} />)
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('sticky')
  })

  it('a second click on the sticky pill collapses it', () => {
    const todos = makeTodos([['a', 'pending']])
    render(<TasksPeek todos={todos} peekMs={PEEK_MS} />)
    fireEvent.click(screen.getByTestId('tasks-peek-toggle'))
    fireEvent.click(screen.getByTestId('tasks-peek-toggle'))
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('collapsed')
  })

  it('after manual close (sticky - collapsed), the next todos change still auto-peeks', () => {
    const t0 = makeTodos([['a', 'pending']])
    const { rerender } = render(<TasksPeek todos={t0} peekMs={PEEK_MS} />)
    // Open then close by clicking twice.
    fireEvent.click(screen.getByTestId('tasks-peek-toggle'))
    fireEvent.click(screen.getByTestId('tasks-peek-toggle'))
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('collapsed')

    // A subsequent todos change should still auto-peek.
    const t1 = makeTodos([['a', 'in_progress']])
    rerender(<TasksPeek todos={t1} peekMs={PEEK_MS} />)
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('peek')
  })

  it('hover pauses the countdown; leave resumes it', () => {
    const t0 = makeTodos([['a', 'pending']])
    const { rerender } = render(<TasksPeek todos={t0} peekMs={PEEK_MS} />)
    const t1 = makeTodos([['a', 'in_progress']])
    rerender(<TasksPeek todos={t1} peekMs={PEEK_MS} />)
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('peek')

    const panel = screen.getByTestId('tasks-peek-panel')
    // Halfway through the window, hover.
    act(() => {
      vi.advanceTimersByTime(PEEK_MS / 2)
    })
    fireEvent.mouseEnter(panel)

    // Now wait way past what would normally have expired the window.
    act(() => {
      vi.advanceTimersByTime(PEEK_MS * 5 + TICK_MS)
    })
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('peek')

    // Leave; remaining ~ PEEK_MS/2 should elapse to close it.
    fireEvent.mouseLeave(panel)
    act(() => {
      vi.advanceTimersByTime(PEEK_MS / 2 + TICK_MS + 10)
    })
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('collapsed')
  })

  it('renders one row per todo with data-status reflecting each status', () => {
    const todos = makeTodos([
      ['a', 'pending'],
      ['b', 'in_progress'],
      ['c', 'completed'],
      ['d', 'cancelled'],
    ])
    render(<TasksPeek todos={todos} peekMs={PEEK_MS} />)
    // Open it so the list renders.
    fireEvent.click(screen.getByTestId('tasks-peek-toggle'))
    const rows = screen.getAllByTestId('tasks-peek-item')
    expect(rows.length).toBe(4)
    expect(rows.map((r) => r.dataset.status)).toEqual([
      'pending',
      'in_progress',
      'completed',
      'cancelled',
    ])
    expect(rows[0].textContent).toContain('a')
    expect(rows[3].textContent).toContain('d')
  })

  it('shows N/M in the pill and treats cancelled + completed as done', () => {
    const todos = makeTodos([
      ['a', 'completed'],
      ['b', 'cancelled'],
      ['c', 'pending'],
    ])
    render(<TasksPeek todos={todos} peekMs={PEEK_MS} />)
    const toggle = screen.getByTestId('tasks-peek-toggle')
    expect(toggle.textContent).toContain('2/3')
    expect(toggle.getAttribute('aria-label')).toBe('Tasks: 2 of 3 done')
  })

  it('animates: panel data-open flips true - false and stays mounted through exit', () => {
    const t0 = makeTodos([['a', 'pending']])
    const { rerender } = render(<TasksPeek todos={t0} peekMs={PEEK_MS} />)
    const t1 = makeTodos([['a', 'in_progress']])
    rerender(<TasksPeek todos={t1} peekMs={PEEK_MS} />)

    // Expanded: data-open is "true".
    expect(screen.getByTestId('tasks-peek-panel').dataset.open).toBe('true')

    // Trigger collapse; mode flips immediately but panel stays mounted for
    // the exit animation with data-open="false".
    act(() => {
      vi.advanceTimersByTime(PEEK_MS + TICK_MS + 10)
    })
    expect(screen.getByTestId('tasks-peek').dataset.mode).toBe('collapsed')
    expect(screen.getByTestId('tasks-peek-panel').dataset.open).toBe('false')

    // After the exit window, the panel unmounts.
    act(() => {
      vi.advanceTimersByTime(EXIT_MS + 10)
    })
    expect(screen.queryByTestId('tasks-peek-panel')).toBeNull()
  })
})
