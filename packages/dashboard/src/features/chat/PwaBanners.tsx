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
import { RefreshCw, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { BannerSlot } from './BannerStack.js'
import { initPwa, type PwaController } from '../../lib/pwa.js'
import { useOnlineStatus } from '../../lib/useOnlineStatus.js'

type PwaState = {
  needRefresh: boolean
  offlineReady: boolean
}

const PWA_INITIAL_STATE: PwaState = { needRefresh: false, offlineReady: false }

type PwaLifecycleContextValue = {
  state: PwaState
  controller: PwaController | null
}

const PwaLifecycleContext = createContext<PwaLifecycleContextValue>({
  state: PWA_INITIAL_STATE,
  controller: null,
})

let cachedController: PwaController | null = null
const lifecycleSubscribers = new Set<(update: Partial<PwaState>) => void>()

function publishLifecycle(update: Partial<PwaState>): void {
  for (const subscriber of lifecycleSubscribers) subscriber(update)
}

/**
 * Mounts once near the app root and owns the SW registration lifecycle.
 * All PWA-driven UI (top banner, composer-adjacent notices, etc.) reads
 * status from this provider instead of registering a second controller.
 */
export function PwaLifecycleHost({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<PwaState>(PWA_INITIAL_STATE)
  const [controller, setController] = useState<PwaController | null>(cachedController)

  useEffect(() => {
    const subscriber = (update: Partial<PwaState>): void => {
      setState((previous) => ({ ...previous, ...update }))
    }
    lifecycleSubscribers.add(subscriber)
    if (cachedController) {
      setController(cachedController)
      return () => { lifecycleSubscribers.delete(subscriber) }
    }
    cachedController = initPwa({
      // The controller outlives any one React mount. Publish to the currently
      // mounted provider instead of capturing the first StrictMode mount's
      // setState, which becomes stale immediately in development and can also
      // become stale across root recovery.
      onNeedRefresh: () => publishLifecycle({ needRefresh: true }),
      onOfflineReady: () => publishLifecycle({ offlineReady: true }),
      onRegisterError: (error) => {
        // eslint-disable-next-line no-console -- surfaced for triage; toast noise unnecessary
        console.warn('[pwa] registration failed', error)
      },
    })
    setController(cachedController)
    return () => { lifecycleSubscribers.delete(subscriber) }
  }, [])

  return (
    <PwaLifecycleContext.Provider value={{ state, controller }}>
      {children}
    </PwaLifecycleContext.Provider>
  )
}

/**
 * Top-anchored PWA update banner. Displayed sticky under AppShellNav so a
 * new SW install can never be missed regardless of scroll position or chat
 * pane state. A waiting generation activates automatically; the button is a
 * manual retry if browser lifecycle events delay that controlled reload.
 */
export function PwaUpdateGlobalBanner(): JSX.Element | null {
  const { t } = useTranslation()
  const { state, controller } = useContext(PwaLifecycleContext)
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

  useEffect(() => {
    if (!state.needRefresh || !controller || reloading) return
    setReloading(true)
    void controller.applyUpdate().catch(() => setReloading(false))
  }, [controller, reloading, state.needRefresh])

  if (!state.needRefresh) return null

  return (
    <div
      className="flex flex-none items-center justify-between gap-2 border-b border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-100"
      data-testid="pwa-update-global-banner"
      role="status"
    >
      <div className="flex min-w-0 items-center gap-2">
        <RefreshCw className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium">{t('pwa.updateAvailable')}</span>
      </div>
      <div className="flex flex-none items-center gap-1">
        <button
          type="button"
          onClick={onReload}
          disabled={reloading}
          className="rounded-md border border-sky-400/60 bg-sky-500 px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-sky-600 disabled:cursor-progress disabled:opacity-60 dark:border-sky-500 dark:bg-sky-600 dark:hover:bg-sky-500"
          data-testid="pwa-update-reload"
        >
          {reloading ? t('pwa.reloading') : t('common.reload')}
        </button>
      </div>
    </div>
  )
}

export function OfflineBanner(): JSX.Element | null {
  const { t } = useTranslation()
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
          {t('pwa.offline')}
        </span>
      </div>
    </BannerSlot>
  )
}
