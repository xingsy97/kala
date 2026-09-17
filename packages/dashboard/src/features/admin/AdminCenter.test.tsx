import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AdminCenter } from './AdminCenter.js'
import { i18n } from '../../i18n/index.js'

afterEach(() => vi.unstubAllGlobals())

it('keeps admin title help available without hiding access failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
  render(<AdminCenter onClose={() => {}} />)
  expect(await screen.findByText(i18n.t('admin.loadFailed'))).toBeTruthy()
  expect(screen.queryByText(i18n.t('admin.subtitle'))).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('common.aboutLabel', { label: i18n.t('admin.title') }) }))
  expect(screen.getByRole('tooltip').textContent).toBe(i18n.t('admin.subtitle'))
  expect(screen.getByText(i18n.t('admin.loadFailed'))).toBeTruthy()
})
