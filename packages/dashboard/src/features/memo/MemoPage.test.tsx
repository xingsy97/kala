import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MemoPage } from './MemoPage.js'

type FetchReply = { ok: boolean; status: number; json(): Promise<unknown> }

function reply(body: unknown, status = 200): FetchReply {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function memo(content: string, revision: number) {
  return { content, revision, updatedAt: '2026-09-26T12:00:00.000Z' }
}

describe('MemoPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(memo('<h1>Project notes</h1><p>Keep this.</p>', 4))))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('loads existing rich content into an accessible editor with formatting controls', async () => {
    render(<MemoPage />)

    const editor = await screen.findByRole('textbox', { name: 'Memo editor' })
    await waitFor(() => expect(editor.textContent).toContain('Project notes'))

    expect(screen.getByRole('toolbar', { name: 'Memo formatting' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Code block' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add image' })).toBeTruthy()
    expect(editor.getAttribute('aria-multiline')).toBe('true')
    expect(editor.getAttribute('aria-keyshortcuts')).toContain('Control+S')
    expect(screen.getByRole('status').textContent).toContain('Saved')
    expect(screen.getByText('4 words')).toBeTruthy()
  })

  it('embeds an uploaded image with alternative text and autosaves it', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(reply(memo('<p>Before image</p>', 7)) as Response)
      .mockResolvedValueOnce(reply(memo('<p>Before image</p>', 8)) as Response)
    render(<MemoPage />)

    const editor = await screen.findByRole('textbox', { name: 'Memo editor' })
    await waitFor(() => expect(editor.textContent).toContain('Before image'))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const image = new File(['tiny-png'], 'diagram.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [image] } })

    await waitFor(() => expect(editor.querySelector('img')?.getAttribute('alt')).toBe('diagram.png'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2000 })

    const [, options] = fetchMock.mock.calls[1]!
    expect(options?.method).toBe('PUT')
    const payload = JSON.parse(String(options?.body)) as { content: string; expectedRevision: number }
    expect(payload.expectedRevision).toBe(7)
    expect(payload.content).toContain('data:image/png;base64,')
    expect(payload.content).toContain('alt="diagram.png"')
  })

  it('embeds images pasted from the clipboard', async () => {
    render(<MemoPage />)
    const editor = await screen.findByRole('textbox', { name: 'Memo editor' })
    await waitFor(() => expect(editor.textContent).toContain('Project notes'))

    const pastedImage = new File(['clipboard-image'], 'clipboard.png', { type: 'image/png' })
    fireEvent.paste(editor, { clipboardData: { files: [pastedImage], getData: () => '' } })

    await waitFor(() => expect(editor.querySelector('img')?.getAttribute('alt')).toBe('clipboard.png'))
  })

  it('rejects oversized images without changing or saving the document', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<MemoPage />)
    await screen.findByRole('textbox', { name: 'Memo editor' })
    await screen.findByText('Saved')

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const largeImage = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [largeImage] } })

    expect((await screen.findByRole('alert')).textContent).toContain('Images must be 5 MB or smaller.')
    await new Promise((resolve) => window.setTimeout(resolve, 550))
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  })

  it('keeps local edits visible on a revision conflict and reloads only on request', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(reply(memo('<p>Local draft</p>', 2)) as Response)
      .mockResolvedValueOnce(reply({}, 409) as Response)
      .mockResolvedValueOnce(reply(memo('<p>Remote draft</p>', 3)) as Response)
    render(<MemoPage />)

    const editor = await screen.findByRole('textbox', { name: 'Memo editor' })
    await waitFor(() => expect(editor.textContent).toContain('Local draft'))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['image'], 'local.png', { type: 'image/png' })] } })

    const reload = await screen.findByRole('button', { name: 'Reload' }, { timeout: 2000 })
    expect(editor.querySelector('img')?.getAttribute('alt')).toBe('local.png')
    expect(editor.getAttribute('contenteditable')).toBe('false')

    fireEvent.click(reload)
    await waitFor(() => expect(editor.textContent).toContain('Remote draft'))
    expect(editor.querySelector('img')).toBeNull()
  })
})
