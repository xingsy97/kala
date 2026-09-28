import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeTextToClipboard } from './clipboard.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('writeTextToClipboard', () => {
  it('uses the browser Clipboard API outside Desktop', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    await writeTextToClipboard('browser text')

    expect(writeText).toHaveBeenCalledWith('browser text')
  })

  it('falls back to a temporary textarea and rejects failed copies', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const execCommand = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await writeTextToClipboard('fallback text')
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
    await expect(writeTextToClipboard('rejected text')).rejects.toThrow('rejected')
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
  })
})
