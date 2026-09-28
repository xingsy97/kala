import { StrictMode } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const applyUpdate = vi.fn(async () => {})
const forceRefresh = vi.fn(async () => {})
let notifyUpdate: (() => void) | undefined

vi.mock('../../lib/pwa.js', () => ({
  initPwa: vi.fn((handlers: { onNeedRefresh(): void }) => {
    notifyUpdate = handlers.onNeedRefresh
    return { applyUpdate, forceRefresh, checkForUpdate: async () => {} }
  }),
}))

import { PwaLifecycleHost, PwaUpdateGlobalBanner } from './PwaBanners.js'

describe('Dashboard PWA lifecycle', () => {
  beforeEach(() => {
    applyUpdate.mockClear()
    forceRefresh.mockClear()
  })

  it('never reloads automatically and applies an update only after confirmation', async () => {
    const view = render(
      <StrictMode>
        <PwaLifecycleHost><PwaUpdateGlobalBanner /></PwaLifecycleHost>
      </StrictMode>,
    )

    act(() => { notifyUpdate?.() })

    await waitFor(() => expect(view.getByTestId('pwa-update-global-banner')).toBeTruthy())
    expect(applyUpdate).not.toHaveBeenCalled()

    view.getByTestId('pwa-update-reload').click()
    await waitFor(() => expect(applyUpdate).toHaveBeenCalledTimes(1))
  })

  it('offers a forced refresh for stale worker and cache state', async () => {
    const view = render(
      <PwaLifecycleHost><PwaUpdateGlobalBanner /></PwaLifecycleHost>,
    )

    act(() => { notifyUpdate?.() })
    await waitFor(() => expect(view.getByTestId('pwa-update-force-refresh')).toBeTruthy())
    view.getByTestId('pwa-update-force-refresh').click()
    await waitFor(() => expect(forceRefresh).toHaveBeenCalledTimes(1))
  })
})
