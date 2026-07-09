/**
 * PWA update + offline banners, wired to BannerStack.
 *
 * Kept in one file so the two composer-adjacent notices that come from the
 * PWA layer (see docs/planning/roadmap-notes/pwa-mobile-and-push.md §4)
 * live together and both use the shared BannerSlot registration protocol.
 *
 * Update banner: appears when a new service worker is `waiting`. Reload is
 * user-initiated so mid-session composer drafts and open approvals aren't
 * dropped by an implicit page reload.
 *
 * Offline banner: appears when useOnlineStatus reports the dashboard cannot
 * reach the host. Uses BannerSlot so it participates in the stack's
 * collapse-when-crowded logic instead of always pushing the composer down.
 */

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, WifiOff, X } from 'lucide-react'

import { BannerSlot } from './BannerStack.js'
import { initPwa, type PwaController } from '../../lib/pwa.js'
import { useOnlineStatus } from '../../lib/useOnlineStatus.js'

let cachedController: PwaController | null = null

type PwaState = {
  needRefresh: boolean
  offlineReady: boolean
  dismissed: boolean
}

const PWA_INITIAL_STATE: PwaState = { needRefresh: false, offlineReady: false, dismissed: false }

export function PwaUpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<PwaState>(PWA_INITIAL_STATE)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    // Register once per document lifetime; multiple mounts (e.g. hot reload
    // in dev) reuse the same controller instead of doubling the poll timer.
    if (cachedController) return
    cachedController = initPwa({
      onNeedRefresh: () => setState((prev) => ({ ...prev, needRefresh: true, dismissed: false })),
      onOfflineReady: () => setState((prev) => ({ ...prev, offlineReady: true })),
      onRegisterError: (error) => {
        // eslint-disable-next-line no-console -- surfaced for triage; toast noise unnecessary
        console.warn('[pwa] registration failed', error)
      },
    })
  }, [])

  const onReload = useCallback(async () => {
    if (!cachedController) return
    setReloading(true)
    try {
      await cachedController.applyUpdate()
    } catch {
      setReloading(false)
    }
  }, [])

  const onDismiss = useCallback(() => {
    setState((prev) => ({ ...prev, dismissed: true }))
  }, [])

  if (!state.needRefresh || state.dismissed) return null

  return (
    <BannerSlot>
      <div
        className="flex items-center justify-between gap-2 border-t border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
        data-testid="pwa-update-banner"
      >
        <div className="flex min-w-0 items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="truncate">A new dashboard version is available.</span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onReload}
            disabled={reloading}
            className="rounded border border-sky-300 bg-white/70 px-2 py-0.5 text-[11px] font-medium text-sky-800 transition-colors hover:bg-white disabled:cursor-progress disabled:opacity-60 dark:border-sky-800 dark:bg-sky-900/40 dark:text-sky-100 dark:hover:bg-sky-900"
            data-testid="pwa-update-reload"
          >
            {reloading ? 'Reloading…' : 'Reload'}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss update notice"
            className="rounded p-0.5 text-sky-700 hover:bg-sky-100 dark:text-sky-300 dark:hover:bg-sky-900"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </BannerSlot>
  )
}

export function OfflineBanner(): JSX.Element | null {
  const { online } = useOnlineStatus()
  if (online) return null
  return (
    <BannerSlot>
      <div
        className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        data-testid="offline-banner"
      >
        <WifiOff className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">
          Offline — showing cached dashboard shell. Live data will resume when connection returns.
        </span>
      </div>
    </BannerSlot>
  )
}
