import type { DesktopNotificationKind } from '@agent-kernel/shared/push'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { appBadgeSupported } from '../../../lib/app-badge.js'
import {
  DESKTOP_NOTIFICATION_PREFS,
  PREF_DESKTOP_NOTIFICATIONS_ENABLED,
  PREF_DESKTOP_NOTIFICATION_SOUND,
  notificationPermission,
  requestNotificationPermission,
} from '../../../lib/desktop-notifications.js'
import {
  currentPushEndpoint,
  detectPushSupport,
  subscribeToPush,
  unsubscribeFromPush,
  type PushSupport,
} from '../../../lib/push.js'
import { PREF_APP_BADGE_ENABLED, useBooleanPref } from '../../../lib/prefs.js'
import { InterfaceToggle, SectionHeader, Toggle } from '../controls.js'

export function NotificationsSection(): JSX.Element {
  const { t } = useTranslation()
  const [appBadgeEnabled, setAppBadgeEnabled] = useBooleanPref(PREF_APP_BADGE_ENABLED, true)
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.notifications.label')}
        subtitle={t('settings.notifications.subtitle')}
      />
      <ul className="space-y-3 text-sm">
        <DesktopNotificationsSettings />
        <BackgroundPushSettings />
        <InterfaceToggle
          label="App badge"
          description={appBadgeSupported() ? 'Show a quiet actionable count on the installed app icon.' : 'App badging is unavailable in this browser.'}
          checked={appBadgeEnabled && appBadgeSupported()}
          onChange={setAppBadgeEnabled}
          testId="settings-toggle-app-badge"
          disabled={!appBadgeSupported()}
        />
      </ul>
    </div>
  )
}

function DesktopNotificationsSettings(): JSX.Element {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useBooleanPref(PREF_DESKTOP_NOTIFICATIONS_ENABLED, false)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => notificationPermission())
  const [busy, setBusy] = useState(false)

  const setDesktopNotifications = async (next: boolean): Promise<void> => {
    if (!next) {
      setEnabled(false)
      return
    }
    const current = notificationPermission()
    if (current === 'granted') {
      setPermission(current)
      setEnabled(true)
      return
    }
    if (current === 'denied' || current === 'unsupported') {
      setPermission(current)
      setEnabled(false)
      return
    }
    setBusy(true)
    try {
      const result = await requestNotificationPermission()
      setPermission(result)
      setEnabled(result === 'granted')
    } finally {
      setBusy(false)
    }
  }

  const unavailable = permission === 'denied' || permission === 'unsupported'
  return (
    <li className="rounded-md border border-border bg-card/60 px-4 py-3">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="font-medium">{t('settings.interface.desktopNotifications')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('settings.interface.desktopNotificationsDesc')}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground" data-testid="desktop-notification-permission">
            {t('settings.interface.permission', { permission: permissionLabel(permission, t) })}
          </p>
        </div>
        <Toggle
          checked={enabled && permission === 'granted'}
          onChange={(next) => { void setDesktopNotifications(next) }}
          ariaLabel={t('settings.interface.enableDesktopNotifications')}
          testId="settings-toggle-desktop-notifications"
          disabled={busy || unavailable}
        />
      </div>
      {unavailable ? (
        <div className="mt-3 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {permission === 'unsupported'
            ? t('settings.interface.notificationUnsupported')
            : t('settings.interface.notificationBlocked')}
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 border-t border-border/50 pt-3">
        <NotificationKindToggle
          prefKey={PREF_DESKTOP_NOTIFICATION_SOUND}
          label={t('settings.interface.sound')}
          description={t('settings.interface.soundDesc')}
          disabled={!enabled || permission !== 'granted'}
        />
        {DESKTOP_NOTIFICATION_PREFS.map((pref) => (
          <NotificationKindToggle key={pref.kind} prefKey={pref.key} label={pref.label} description={pref.description} disabled={!enabled || permission !== 'granted'} />
        ))}
      </div>
    </li>
  )
}

function BackgroundPushSettings(): JSX.Element {
  const [support] = useState<PushSupport>(() => detectPushSupport())
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverStatus, setServerStatus] = useState<{ configured: boolean; subscribers: number } | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  const refreshStatus = async (): Promise<void> => {
    try {
      const res = await fetch('/push/status', { credentials: 'same-origin', cache: 'no-store' })
      if (res.ok) setServerStatus(await res.json())
    } catch {
      // Non-fatal: status is diagnostic only.
    }
  }

  useEffect(() => {
    let cancelled = false
    void currentPushEndpoint().then((ep) => {
      if (!cancelled) setEndpoint(ep)
    })
    void refreshStatus()
    return () => { cancelled = true }
  }, [])

  const enable = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // Use the same per-kind toggles as foreground notifications — reading
      // localStorage directly avoids threading N hooks up to this level.
      const kinds = collectEnabledKinds()
      const result = await subscribeToPush(kinds)
      if (result.ok) {
        setEndpoint(result.endpoint)
        await refreshStatus()
      } else {
        setError(explainPushFailure(result.reason))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const disable = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await unsubscribeFromPush()
      setEndpoint(null)
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async (): Promise<void> => {
    setBusy(true)
    setTestResult(null)
    setError(null)
    try {
      const res = await fetch('/push/test', { method: 'POST', credentials: 'same-origin' })
      if (!res.ok) {
        setTestResult(`HTTP ${res.status}`)
      } else {
        const body = (await res.json()) as { delivered?: number }
        setTestResult(`server dispatched to ${body.delivered ?? 0} subscriber(s) — check for the notification`)
      }
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const active = endpoint !== null

  return (
    <li className="rounded-md border border-border bg-card/60 px-4 py-3" data-testid="settings-push-section">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="font-medium">Background push (Web Push)</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Deliver approval, waiting, and error notifications even when the dashboard tab is closed.
            Uses your per-kind toggles above.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {active
              ? 'Subscribed on this device.'
              : support.supported
                ? 'Not subscribed on this device.'
                : `Unavailable: ${explainSupport(support.reason)}`}
          </p>
          {serverStatus ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="settings-push-server-status">
              Host: VAPID {serverStatus.configured ? 'configured' : 'missing'} · {serverStatus.subscribers} subscriber(s) known.
            </p>
          ) : null}
        </div>
        <Toggle
          checked={active}
          onChange={(next) => { void (next ? enable() : disable()) }}
          ariaLabel="Enable background push"
          testId="settings-toggle-background-push"
          disabled={busy || !support.supported}
        />
      </div>
      {active ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="settings-push-test"
            onClick={() => { void sendTest() }}
            disabled={busy}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            Send test push
          </button>
          {testResult ? (
            <span className="text-[11px] text-muted-foreground">{testResult}</span>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 rounded-md border border-rose-300/70 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
          {error}
        </div>
      ) : null}
    </li>
  )
}

function NotificationKindToggle({
  prefKey,
  label,
  description,
  disabled,
}: {
  prefKey: string
  label: string
  description: string
  disabled: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [checked, setChecked] = useBooleanPref(prefKey, true)
  return (
    <div className="flex flex-col gap-3 rounded-md bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
      <Toggle
        checked={checked}
        onChange={setChecked}
        ariaLabel={t('settings.interface.notify', { label })}
        testId={`settings-toggle-notification-${prefKey}`}
        disabled={disabled}
      />
    </div>
  )
}

function collectEnabledKinds(): readonly DesktopNotificationKind[] {
  const kinds: DesktopNotificationKind[] = []
  for (const pref of DESKTOP_NOTIFICATION_PREFS) {
    // Per-kind prefs default to true; only skip when explicitly disabled.
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(pref.key)
    const enabled = raw === null ? true : raw !== 'false'
    if (enabled) kinds.push(pref.kind as DesktopNotificationKind)
  }
  return kinds
}

function explainSupport(reason: PushSupport['reason']): string {
  switch (reason) {
    case 'no_service_worker': return 'this browser has no service worker support'
    case 'no_push_manager': return 'this browser has no PushManager'
    case 'no_notification': return 'this browser has no Notification API'
    case 'ios_needs_standalone': return 'add RunLab to your home screen first (iOS restriction)'
    default: return 'push is not available in this context'
  }
}

function explainPushFailure(reason: 'permission_denied' | 'no_vapid' | 'subscribe_failed' | 'server_rejected'): string {
  switch (reason) {
    case 'permission_denied': return 'Browser denied the notification permission. Enable it in site settings.'
    case 'no_vapid': return 'The host has no VAPID keys configured; push cannot be enabled.'
    case 'subscribe_failed': return 'Failed to subscribe with the browser push service.'
    case 'server_rejected': return 'The host rejected the subscription payload.'
  }
}

function permissionLabel(permission: NotificationPermission | 'unsupported', t: ReturnType<typeof useTranslation>['t']): string {
  if (permission === 'default') return t('settings.interface.permissionDefault')
  if (permission === 'unsupported') return t('settings.interface.permissionUnsupported')
  return permission
}
