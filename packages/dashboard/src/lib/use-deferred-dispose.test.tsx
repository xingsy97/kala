import { StrictMode } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDeferredDispose } from './use-deferred-dispose.js'

describe('useDeferredDispose', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('survives the Strict Mode effect probe and disposes replaced resources', () => {
    vi.useFakeTimers()
    const first = { close: vi.fn() }
    const second = { close: vi.fn() }
    const Probe = ({ resource }: { resource: typeof first }): null => {
      useDeferredDispose(resource, (current) => current.close())
      return null
    }

    const view = render(<StrictMode><Probe resource={first} /></StrictMode>)
    act(() => vi.runAllTimers())
    expect(first.close).not.toHaveBeenCalled()

    view.rerender(<StrictMode><Probe resource={second} /></StrictMode>)
    act(() => vi.runAllTimers())
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()

    view.unmount()
    act(() => vi.runAllTimers())
    expect(second.close).toHaveBeenCalledTimes(1)
  })
})
