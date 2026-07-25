import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { EmptyRow, SectionHeader, SettingsKeyValueList } from '../controls.js'

export function SocketAdminSection({ payload, onPayloadChange }: { payload: ServerSettingsPayload; onPayloadChange(payload: ServerSettingsPayload): void }): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'development' | 'production'>(payload.socketAdmin?.configuredMode ?? payload.socketAdmin?.runtimeMode ?? 'development')
  const [error, setError] = useState<string | null>(null)
  const admin = payload.socketAdmin
  useEffect(() => {
    setMode(payload.socketAdmin?.configuredMode ?? payload.socketAdmin?.runtimeMode ?? 'development')
  }, [payload.socketAdmin?.configuredMode, payload.socketAdmin?.runtimeMode])
  const init = useMutation({
    mutationFn: async (): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/socket-admin/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, mode }),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      setPassword('')
      setError(null)
      onPayloadChange(next)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  const updateMode = useMutation({
    mutationFn: async (nextMode: 'development' | 'production'): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/socket-admin/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: nextMode }),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      setError(null)
      onPayloadChange(next)
      setMode(next.socketAdmin?.configuredMode ?? next.socketAdmin?.runtimeMode ?? mode)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  if (!admin) {
    return (
      <div>
        <SectionHeader title={t('settings.sections.socketAdmin.label')} subtitle={t('settings.socketAdmin.subtitle')} />
        <EmptyRow>{t('settings.socketAdmin.unavailable')}</EmptyRow>
      </div>
    )
  }
  if (!admin.initialized) {
    return (
      <div>
        <SectionHeader title={t('settings.sections.socketAdmin.label')} subtitle={t('settings.socketAdmin.subtitle')} />
        <form
          className="space-y-4 rounded-md bg-muted/30 p-4 ring-1 ring-border/50"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            init.mutate()
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.6fr)]">
            <div className="min-w-0">
              <label className="text-sm font-medium text-foreground" htmlFor="socket-admin-password">{t('settings.socketAdmin.initialPassword')}</label>
              <input
                id="socket-admin-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                autoComplete="new-password"
                minLength={8}
                required
              />
              <p className="mt-2 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{t('settings.socketAdmin.initialPasswordDesc', { path: admin.configPath })}</p>
            </div>
            <label className="min-w-0 text-sm font-medium text-foreground">
              {t('settings.socketAdmin.initialMode')}
              <select
                className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                value={mode}
                onChange={(event) => setMode(event.currentTarget.value === 'development' ? 'development' : 'production')}
                disabled={init.isPending}
                data-testid="settings-socket-admin-initial-mode-select"
              >
                <option value="production">{t('settings.socketAdmin.modeProduction')}</option>
                <option value="development">{t('settings.socketAdmin.modeDevelopment')}</option>
              </select>
              <p className="mt-2 text-xs text-muted-foreground">{t('settings.socketAdmin.modeDesc')}</p>
            </label>
          </div>
          {error ? <div className="text-xs text-destructive">{error}</div> : null}
          <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={init.isPending || password.trim().length < 8}>{t('settings.socketAdmin.initialize')}</Button>
        </form>
      </div>
    )
  }
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const href = `${origin}${admin.path}`
  const configuredMode = admin.configuredMode
  const rows: Array<[string, string]> = [
    [t('settings.socketAdmin.path'), admin.path],
    [t('settings.socketAdmin.username'), admin.username],
    [t('settings.socketAdmin.runtimeMode'), admin.runtimeMode],
    [t('settings.socketAdmin.configuredMode'), configuredMode],
    [t('settings.socketAdmin.configPath'), admin.configPath],
    ...(admin.createdAt ? [[t('settings.socketAdmin.createdAt'), admin.createdAt] as [string, string]] : []),
    ...(admin.distSource ? [[t('settings.socketAdmin.distSource'), t(`settings.socketAdmin.dist.${admin.distSource}`)] as [string, string]] : []),
  ]
  return (
    <div>
      <SectionHeader title={t('settings.sections.socketAdmin.label')} subtitle={t('settings.socketAdmin.subtitle')} />
      {admin.restartRequired ? (
        <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300" data-testid="settings-socket-admin-restart-required">
          {t('settings.socketAdmin.modeRestartRequired', { current: admin.runtimeMode, configured: configuredMode })}
        </div>
      ) : null}
      <div className="mb-4 flex min-w-0 flex-col gap-3 rounded-md bg-black/[0.18] p-4 ring-1 ring-white/10 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t('settings.socketAdmin.openTitle')}</div>
          <div className="mt-1 break-all font-mono text-xs text-muted-foreground" title={href}>{href}</div>
        </div>
        {admin.active ? (
          <Button type="button" variant="outline" size="sm" className="h-8 flex-none" asChild>
            <a href={href} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.socketAdmin.open')}
            </a>
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" className="h-8 flex-none" disabled>
            <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.socketAdmin.open')}
          </Button>
        )}
      </div>
      <div className="mb-4 rounded-md bg-black/[0.18] p-4 ring-1 ring-white/10">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="min-w-0">
            <label className="text-sm font-medium text-foreground" htmlFor="socket-admin-mode-select">
              {t('settings.socketAdmin.configuredMode')}
            </label>
            <select
              id="socket-admin-mode-select"
              className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
              value={mode}
              onChange={(event) => setMode(event.currentTarget.value === 'development' ? 'development' : 'production')}
              disabled={updateMode.isPending}
              data-testid="settings-socket-admin-mode-select"
            >
              <option value="production">{t('settings.socketAdmin.modeProduction')}</option>
              <option value="development">{t('settings.socketAdmin.modeDevelopment')}</option>
            </select>
          </div>
          <Button type="button" size="sm" className="h-9 w-full sm:mt-7 sm:w-auto" disabled={updateMode.isPending || mode === configuredMode} onClick={() => updateMode.mutate(mode)} data-testid="settings-socket-admin-save-mode">
            {t('settings.socketAdmin.saveMode')}
          </Button>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('settings.socketAdmin.modeDesc')}</p>
      </div>
      <SettingsKeyValueList rows={rows.map(([label, value]) => ({
        label,
        value: <span className="break-all font-mono text-xs text-muted-foreground">{value}</span>,
      }))} />
    </div>
  )
}
