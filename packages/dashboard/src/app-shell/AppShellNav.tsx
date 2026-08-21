import { useTranslation } from 'react-i18next'
import { BookOpen, Bot, Boxes, ChevronUp, CircleHelp, ExternalLink, LogOut, NotebookPen, Settings as SettingsIcon, Sparkles, UserRound, Workflow } from 'lucide-react'
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '../components/ui/button.js'
import { cn } from '../lib/utils.js'
import type { AccountProfile } from '../auth-session.js'
import type { AppSection } from './section.js'
import { resolveEvaluationPlatformUrl } from '../evaluation-integration.js'

type NavItem = {
  id: AppSection
  labelKey: string
  Icon: typeof Bot
  testid: string
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'agent', labelKey: 'appShell.nav.agent', Icon: Bot, testid: 'app-shell-nav-agent' },
  { id: 'operations', labelKey: 'appShell.nav.operations', Icon: Workflow, testid: 'app-shell-nav-operations' },
  { id: 'artifacts', labelKey: 'appShell.nav.artifacts', Icon: Boxes, testid: 'app-shell-nav-artifacts' },
  { id: 'pipeline', labelKey: 'appShell.nav.pipeline', Icon: Sparkles, testid: 'app-shell-nav-pipeline' },
  { id: 'docs', labelKey: 'appShell.nav.docs', Icon: BookOpen, testid: 'app-shell-nav-docs' },
  { id: 'memo', labelKey: 'appShell.nav.memo', Icon: NotebookPen, testid: 'app-shell-nav-memo' },
]

type ActivePill = {
  left: number
  top: number
  width: number
  height: number
}

export function AppShellNav({
  section,
  onSelect,
  onOpenSettings,
  connectionStatus,
  collapsed,
  onCollapse,
  account,
  accountLoading = false,
  onSignOut,
  onOpenAccount,
  onOpenAdmin,
  evaluationEnabled = true,
}: {
  section: AppSection
  onSelect(section: AppSection): void
  onOpenSettings(): void
  connectionStatus?: ReactNode
  collapsed: boolean
  onCollapse(): void
  onExpand(): void
  account?: AccountProfile
  accountLoading?: boolean
  onSignOut?(): void | Promise<void>
  onOpenAccount?(): void
  onOpenAdmin?(): void
  evaluationEnabled?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const navItemsRef = useRef<HTMLDivElement | null>(null)
  const activeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [activePill, setActivePill] = useState<ActivePill | null>(null)

  const measureActivePill = useCallback(() => {
    const container = navItemsRef.current
    const activeButton = activeButtonRef.current
    if (!container || !activeButton) {
      setActivePill(null)
      return
    }
    const containerRect = container.getBoundingClientRect()
    const activeRect = activeButton.getBoundingClientRect()
    setActivePill({
      left: activeRect.left - containerRect.left + container.scrollLeft,
      top: activeRect.top - containerRect.top,
      width: Math.max(0, activeRect.width),
      height: Math.max(0, activeRect.height),
    })
  }, [])

  useLayoutEffect(() => {
    if (collapsed) return
    measureActivePill()
    const container = navItemsRef.current
    if (!container) return
    const resizeObserver = new ResizeObserver(measureActivePill)
    resizeObserver.observe(container)
    if (activeButtonRef.current) resizeObserver.observe(activeButtonRef.current)
    container.addEventListener('scroll', measureActivePill, { passive: true })
    window.addEventListener('resize', measureActivePill)
    return () => {
      resizeObserver.disconnect()
      container.removeEventListener('scroll', measureActivePill)
      window.removeEventListener('resize', measureActivePill)
    }
  }, [collapsed, measureActivePill, section])

  if (collapsed) return <></>

  return (
    <nav
      aria-label={t('appShell.nav.aria')}
      data-testid="app-shell-nav"
      data-collapsed="false"
      className="sticky top-0 z-30 flex h-11 items-center gap-1 border-b border-border/60 bg-background/95 px-2 backdrop-blur sm:px-3"
    >
      <span
        aria-label="Agent Kernel"
        className="group mr-4 hidden items-center gap-2.5 text-foreground sm:flex"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5 text-foreground/90 transition-transform duration-200 ease-out group-hover:rotate-[2deg] group-hover:scale-[1.04] motion-reduce:transition-none"
          fill="none"
          aria-hidden
        >
          <path
            d="M12 3.75v16.5M3.75 12h16.5M6.15 6.15l11.7 11.7M17.85 6.15l-11.7 11.7"
            className="stroke-foreground/25 transition-opacity duration-200 group-hover:opacity-80"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
          <circle cx="12" cy="12" r="2.8" className="fill-foreground" />
          <circle cx="12" cy="3.75" r="1.35" className="fill-foreground/70" />
          <circle cx="20.25" cy="12" r="1.35" className="fill-foreground/70" />
          <circle cx="12" cy="20.25" r="1.35" className="fill-foreground/70" />
          <circle cx="3.75" cy="12" r="1.35" className="fill-foreground/70" />
        </svg>
        <span className="text-[13px] font-medium tracking-[-0.025em] text-foreground/90">
          Agent Kernel
        </span>
      </span>
      <div
        ref={navItemsRef}
        className="relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto snap-x snap-mandatory [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:overflow-visible"
      >
        {activePill ? (
          <span
            className="pointer-events-none absolute z-0 rounded-lg bg-accent shadow-[inset_0_0_0_1px_hsl(var(--border)/0.4)] transition-[transform,width,height,opacity] duration-200 ease-out motion-reduce:transition-none"
            style={{
              width: activePill.width,
              height: activePill.height,
              transform: `translate3d(${activePill.left}px, ${activePill.top}px, 0)`,
            }}
            aria-hidden
          />
        ) : null}
        {NAV_ITEMS.map(({ id, labelKey, Icon, testid }) => {
          const active = section === id
          return (
            <Button
              key={id}
              variant="ghost"
              size="sm"
              ref={active ? activeButtonRef : undefined}
              data-testid={testid}
              aria-current={active ? 'page' : undefined}
              title={t(labelKey)}
              onClick={() => onSelect(id)}
              className={cn(
                'relative z-10 h-9 flex-none snap-start gap-1.5 overflow-hidden px-2 text-xs transition-colors duration-150 sm:h-8 sm:px-2.5',
                active
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
            >
              <Icon className="relative h-4 w-4 flex-none" aria-hidden />
              <span className="relative hidden lg:inline">{t(labelKey)}</span>
            </Button>
          )
        })}
      </div>
      <span className="ml-auto flex flex-none items-center gap-1">
        {evaluationEnabled ? (
          <Button variant="ghost" size="icon" asChild className="h-9 w-9 text-muted-foreground hover:text-foreground sm:h-8 sm:w-8">
            <a href={resolveEvaluationPlatformUrl()} target="_blank" rel="noreferrer" data-testid="app-shell-open-evaluation" title={t('appShell.nav.evaluation')} aria-label={t('appShell.nav.evaluation')}><ExternalLink className="h-4 w-4" aria-hidden /></a>
          </Button>
        ) : null}
        {account || accountLoading ? <AccountMenu account={account} loading={accountLoading} onSignOut={onSignOut} onOpenAccount={onOpenAccount} onOpenAdmin={onOpenAdmin} /> : null}
        <Button
          variant="ghost"
          size="icon"
          data-testid="app-shell-nav-settings-icon"
          onClick={onOpenSettings}
          title={t('app.openSettings')}
          aria-label={t('app.openSettings')}
          className="h-9 w-9 text-muted-foreground hover:text-foreground sm:h-8 sm:w-8"
        >
          <SettingsIcon className="h-4 w-4" aria-hidden />
        </Button>
        {connectionStatus}
        <Button
          variant="ghost"
          size="icon"
          data-testid="app-shell-nav-collapse"
          onClick={onCollapse}
          title={t('app.collapseTopbar')}
          aria-label={t('app.collapseTopbar')}
          className="h-9 w-9 text-muted-foreground hover:text-foreground sm:h-8 sm:w-8"
        >
          <ChevronUp className="h-4 w-4" aria-hidden />
        </Button>
      </span>
    </nav>
  )
}

function AccountMenu({ account, loading, onSignOut, onOpenAccount, onOpenAdmin }: { account?: AccountProfile; loading: boolean; onSignOut?(): void | Promise<void>; onOpenAccount?(): void; onOpenAdmin?(): void }): JSX.Element {
  const { t } = useTranslation()
  const detailsRef = useRef<HTMLDetailsElement | null>(null)
  const close = (): void => { if (detailsRef.current) detailsRef.current.open = false }
  const prepareNativeSignOut = (): void => {
    // Changing auth state during submit can unmount the form before the browser
    // commits its authoritative POST navigation. Clean up only after pagehide.
    if (!onSignOut) return
    window.addEventListener('pagehide', () => { void onSignOut() }, { once: true })
  }
  return (
    <details ref={detailsRef} className="relative" data-testid="account-menu">
      <summary className="flex h-9 min-w-9 cursor-pointer list-none items-center justify-center gap-2 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground sm:h-8 [&::-webkit-details-marker]:hidden" aria-label={account ? t('appShell.account.trigger', { name: account.displayName }) : t('appShell.account.loading')} data-testid="account-menu-trigger">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">{loading ? '…' : account?.initials ?? <UserRound className="h-4 w-4" aria-hidden />}</span>
        {account ? <span className="hidden max-w-32 truncate lg:inline">{account.displayName}</span> : null}
      </summary>
      <div className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl" role="menu">
        <div className="border-b border-border/60 px-4 py-3" data-testid="account-identity-summary"><div className="truncate text-sm font-semibold">{account?.displayName ?? t('appShell.account.loadingLong')}</div>{account?.email ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{account.email}</div> : null}</div>
        <div className="p-1.5">
          <a href="#/docs" role="menuitem" onClick={close} className="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm hover:bg-accent"><CircleHelp className="h-4 w-4" aria-hidden />{t('appShell.account.help')}</a>
          <button type="button" role="menuitem" onClick={() => { close(); onOpenAccount?.() }} data-testid="account-details" className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-accent"><UserRound className="h-4 w-4" aria-hidden />{t('appShell.account.details')}</button>
          {onOpenAdmin ? <button type="button" role="menuitem" onClick={() => { close(); onOpenAdmin() }} data-testid="organization-admin" className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-accent"><SettingsIcon className="h-4 w-4" aria-hidden />{t('appShell.account.administration')}</button> : null}
          <div className="px-3 py-2 text-[11px] text-muted-foreground">Agent RunLab · {t('appShell.account.routing')}</div>
          <form method="post" action="/auth/logout" onSubmit={prepareNativeSignOut}>
            <button type="submit" role="menuitem" data-testid="account-sign-out" className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-destructive hover:bg-destructive/10"><LogOut className="h-4 w-4" aria-hidden />{t('appShell.account.signOut')}</button>
          </form>
        </div>
      </div>
    </details>
  )
}
