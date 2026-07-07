import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => {
  const info = vi.fn()
  const success = vi.fn()
  const warning = vi.fn()
  const error = vi.fn()
  const dismiss = vi.fn()
  return {
    toast: { info, success, warning, error, dismiss },
    __esModule: true,
  }
})

import { toast } from 'sonner'
import { notify } from './notify.js'

const mocked = toast as unknown as {
  info: ReturnType<typeof vi.fn>
  success: ReturnType<typeof vi.fn>
  warning: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
}

describe('notify', () => {
  beforeEach(() => {
    mocked.info.mockClear()
    mocked.success.mockClear()
    mocked.warning.mockClear()
    mocked.error.mockClear()
    mocked.dismiss.mockClear()
  })

  it('forwards each kind to the matching sonner method', () => {
    notify.info('i')
    notify.success('s')
    notify.warning('w')
    notify.error('e')
    expect(mocked.info).toHaveBeenCalledWith('i', undefined)
    expect(mocked.success).toHaveBeenCalledWith('s', undefined)
    expect(mocked.warning).toHaveBeenCalledWith('w', undefined)
    expect(mocked.error).toHaveBeenCalledWith('e', undefined)
  })

  it('translates NotifyOpts to sonner ExternalToast, keeping only defined fields', () => {
    const onClick = vi.fn()
    notify.info('hello', {
      description: 'desc',
      action: { label: 'Do', onClick },
      duration: 1234,
      id: 'x',
    })
    expect(mocked.info).toHaveBeenCalledTimes(1)
    const [, opts] = mocked.info.mock.calls[0]!
    expect(opts).toEqual({
      description: 'desc',
      action: { label: 'Do', onClick },
      duration: 1234,
      id: 'x',
    })
  })

  it('omits keys the caller left unset', () => {
    notify.warning('w', { id: 'only' })
    const [, opts] = mocked.warning.mock.calls[0]!
    expect(opts).toEqual({ id: 'only' })
  })

  it('dismiss forwards the id or dismisses all', () => {
    notify.dismiss('a')
    expect(mocked.dismiss).toHaveBeenCalledWith('a')
    notify.dismiss()
    expect(mocked.dismiss).toHaveBeenCalledWith()
  })
})
