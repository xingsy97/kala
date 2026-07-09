/**
 * PWA lifecycle host + top-anchored update banner + composer-adjacent
 * offline banner.
 *
 * The update banner used to live inside BannerStack (chat pane bottom),
 * but users on a broken cached build might never scroll down to see it.
 * It's now rendered at the top of the app shell (below AppShellNav) so a
 * fresh SW install is always in the user's face and one tap away from
 * activation.
 *
 * Offline banner stays in the composer-adjacent BannerStack — being
 * offline while the app itself works is a secondary signal, not a
 * pop-up-worthy interruption.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw, WifiOff, X } from 'lucide-react'

import { BannerSlot } from './BannerStack.js'
import { initPwa, type PwaController } from '../../lib/pwa.js'
import { useOnlineStatus } from '../../lib/useOnlineStatus.js'

type PwaState = {
  needRefresh: boolean
  offlineReady: boolean
  dismissed: boolean
}

const PWA_INITIAL_STATE: PwaState = { needRefresh: false, offlineReady: false, dismissed: false }

type PwaLifecycleContextValue = {
  state: PwaState
  controller: PwaController | null
  dismiss: () => void
}

const PwaLifecycleContext = createContext<PwaLifecycleContextValue>({
  state: PWA_INITIAL_STATE,
  controller: null,
  dismiss: () => {},
})

let cachedController: PwaController | null = null

/**
 * Mounts once near the app root and owns the SW registration lifecycle.
 * All PWA-driven UI (top banner, composer-adjacent notices, etc.) reads
 * status from this provider instead of registering a second controller.
 */
export function PwaLifecycleHost({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<PwaState>(PWA_INITIAL_STATE)
  const [controller, setController] = useState<PwaController | null>(cachedController)

  useEffect(() => {
    if (cachedController) {
      setController(cachedController)
      return
    }
    cachedController = initPwa({
      onNeedRefresh: () => setState((prev) => ({ ...prev, needRefresh: true, dismissed: false })),
      onOfflineReady: () => setState((prev) => ({ ...prev, offlineReady: true })),
      onRegisterError: (error) => {
        // eslint-disable-next-line no-console -- surfaced for triage; toast noise unnecessary
        console.warn('[pwa] registration failed', error)
      },
    })
    setController(cachedController)
  }, [])

  const dismiss = useCallback(() => {
    setState((prev) => ({ ...prev, dismissed: true }))
  }, [])

  return (
    <PwaLifecycleContext.Provider value={{ state, controller, dismiss }}>
      {children}
    </PwaLifecycleContext.Provider>
  )
}

/**
 * Top-anchored PWA update banner. Displayed sticky under AppShellNav so a
 * new SW install can never be missed regardless of scroll position or chat
 * pane state. One tap on Reload activates the waiting worker (through
 * `applyUpdate`) which posts SKIP_WAITING to the SW, controls it, and
 * hard-reloads the page.
 */
export function PwaUpdateGlobalBanner(): JSX.Element | null {
  const { state, controller, dismiss } = useContext(PwaLifecycleContext)
  const [reloading, setReloading] = useState(false)

  const onReload = useCallback(async () => {
    if (!controller) return
    setReloading(true)
    try {
      await controller.applyUpdate()
    } catch {
      setReloading(false)
    }
  }, [controller])

  if (!state.needRefresh || state.dismissed) return null

  return (
    <div
      className="flex flex-none items-center justify-between gap-2 border-b border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-100"
      data-testid="pwa-update-global-banner"
      role="status"
    >
      <div className="flex min-w-0 items-center gap-2">
        <RefreshCw className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium">New dashboard version available.</span>
      </div>
      <div className="flex flex-none items-center gap-1">
        <button
          type="button"
          onClick={onReload}
          disabled={reloading}
          className="rounded-md border border-sky-400/60 bg-sky-500 px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-sky-600 disabled:cursor-progress disabled:opacity-60 dark:border-sky-500 dark:bg-sky-600 dark:hover:bg-sky-500"
          data-testid="pwa-update-reload"
        >
          {reloading ? 'Reloading…' : 'Reload'}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss update notice"
          className="rounded p-0.5 text-sky-800 hover:bg-sky-100 dark:text-sky-200 dark:hover:bg-sky-900"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export function OfflineBanner(): JSX.Element | null {
  const { online } = useOnlineStatus()
  if (online) return null
  return (
    <BannerSlot>
      <div
        className="flex min-w-0 items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
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
