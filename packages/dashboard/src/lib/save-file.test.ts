import { beforeEach, describe, expect, it, vi } from 'vitest'

import { saveFile } from './save-file.js'

describe('saveFile', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  it('writes through the native picker when supported', async () => {
    const write = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }))
    await expect(saveFile({ suggestedName: 'a.txt', blob: new Blob(['a'], { type: 'text/plain' }) }, { ...window, showSaveFilePicker } as never)).resolves.toBe('saved')
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.txt', types: [{ description: 'text/plain', accept: { 'text/plain': ['.txt'] } }] })
    expect(write).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('treats picker cancellation as a quiet cancellation', async () => {
    const showSaveFilePicker = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError') })
    await expect(saveFile({ suggestedName: 'a.txt', blob: new Blob(['a']) }, { ...window, showSaveFilePicker } as never)).resolves.toBe('cancelled')
  })

  it('falls back to a browser download when unsupported', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await expect(saveFile({ suggestedName: 'a.txt', blob: new Blob(['a']) })).resolves.toBe('downloaded')
    expect(click).toHaveBeenCalledOnce()
  })

  it('falls back to a browser download when the picker fails', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const showSaveFilePicker = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError') })
    const pickerWindow = Object.assign(Object.create(window) as Window, { showSaveFilePicker })
    await expect(saveFile({ suggestedName: 'a.txt', blob: new Blob(['a'], { type: 'text/plain;charset=utf-8' }) }, pickerWindow as never)).resolves.toBe('downloaded')
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.txt', types: [{ description: 'text/plain', accept: { 'text/plain': ['.txt'] } }] })
    expect(click).toHaveBeenCalledOnce()
  })
})
