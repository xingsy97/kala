import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountCenter } from './AccountCenter.js'
import { i18n } from '../../i18n/index.js'

describe('AccountCenter', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads sessions and revokes a remote browser session', async () => {
    const sessions = [{ id: 'current', current: true, device: { label: 'Chrome on Linux' }, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date().toISOString() }, { id: 'phone', current: false, device: { label: 'Safari on iPhone' }, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date().toISOString() }]
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: sessions.slice(0, 1) }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    render(<AccountCenter profile={{ displayName: 'Alice', email: 'alice@example.test', initials: 'AE' }} onClose={() => {}} />)
    expect(await screen.findByText(/Safari on iPhone/u)).toBeTruthy()
    const row = screen.getByTestId('account-session-phone')
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/auth/sessions/phone', expect.objectContaining({ method: 'DELETE' })))
    await waitFor(() => expect(screen.queryByText(/Safari on iPhone/u)).toBeNull())
  })

  it('shows retry on load failure and provides logout-all POST form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })))
    render(<AccountCenter profile={{ displayName: 'Alice', initials: 'A' }} onClose={() => {}} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(i18n.t('account.subtitle'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.aboutLabel', { label: i18n.t('account.title') }) }))
    expect(screen.getByRole('tooltip').textContent).toBe(i18n.t('account.subtitle'))
    expect(screen.getByRole('alert')).toBeTruthy()
    const form = screen.getByText('Sign out all devices').closest('form')
    expect(form?.method).toContain('post')
    expect(form?.getAttribute('action')).toBe('/auth/logout-all')
  })
})
