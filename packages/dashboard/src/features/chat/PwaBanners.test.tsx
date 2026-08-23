import { StrictMode } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const applyUpdate = vi.fn(async () => {})
let notifyUpdate: (() => void) | undefined

vi.mock('../../lib/pwa.js', () => ({
  initPwa: vi.fn((handlers: { onNeedRefresh(): void }) => {
    notifyUpdate = handlers.onNeedRefresh
    return { applyUpdate, checkForUpdate: async () => {} }
  }),
}))

import { PwaLifecycleHost, PwaUpdateGlobalBanner } from './PwaBanners.js'

describe('Dashboard PWA lifecycle', () => {
  it('activates a waiting generation after the StrictMode remount', async () => {
    render(
      <StrictMode>
        <PwaLifecycleHost><PwaUpdateGlobalBanner /></PwaLifecycleHost>
      </StrictMode>,
    )

    act(() => { notifyUpdate?.() })

    await waitFor(() => expect(applyUpdate).toHaveBeenCalledTimes(1))
  })
})
