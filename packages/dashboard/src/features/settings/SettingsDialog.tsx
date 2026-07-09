import { useEffect, useState, type FormEvent } from 'react'
import { Check, Copy, ExternalLink, Monitor, Moon, Plus, RefreshCw, Sun, Trash2 } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AttachedExecutor, ExecutorInviteSummary, ServerExecutorInvitePayload, ServerExecutorInvitesPayload, ServerSettingsPayload } from '@agent-kernel/shared'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import {
  DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  PREF_EXPLORER_OPEN,
  PREF_INSPECTOR_OPEN,
  PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  PREF_SHOW_TOOL_CALL_TAB,
  PREF_TOPBAR_OPEN,
  useBooleanPref,
  useNumberPref,
} from '../../lib/prefs.js'
import { useTheme } from '../../lib/theme.js'
import { getStoredHostEndpoint, resolveHostEndpoint, setStoredHostEndpoint } from '../../host-endpoint.js'
import {
  DESKTOP_NOTIFICATION_PREFS,
  PREF_DESKTOP_NOTIFICATIONS_ENABLED,
  PREF_DESKTOP_NOTIFICATION_SOUND,
  notificationPermission,
  requestNotificationPermission,
} from '../../lib/desktop-notifications.js'
import packageJson from '../../../package.json'

const DASHBOARD_VERSION = packageJson.version

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  onModelsChanged?(): void
  executors?: readonly AttachedExecutor[]
}

type SectionKey = 'runtime' | 'connection' | 'models' | 'security' | 'executorAccess' | 'approvals' | 'hooks' | 'mcp' | 'interface' | 'versions'

const SECTIONS: readonly { key: SectionKey; label: string; hint: string }[] = [
  { key: 'interface', label: 'settings.sections.interface.label', hint: 'settings.sections.interface.hint' },
  { key: 'versions', label: 'settings.sections.versions.label', hint: 'settings.sections.versions.hint' },
  { key: 'connection', label: 'settings.sections.connection.label', hint: 'settings.sections.connection.hint' },
  { key: 'executorAccess', label: 'settings.sections.executorAccess.label', hint: 'settings.sections.executorAccess.hint' },
  { key: 'models', label: 'settings.sections.models.label', hint: 'settings.sections.models.hint' },
  { key: 'approvals', label: 'settings.sections.approvals.label', hint: 'settings.sections.approvals.hint' },
  { key: 'security', label: 'settings.sections.security.label', hint: 'settings.sections.security.hint' },
  { key: 'hooks', label: 'settings.sections.hooks.label', hint: 'settings.sections.hooks.hint' },
  { key: 'mcp', label: 'settings.sections.mcp.label', hint: 'settings.sections.mcp.hint' },
  { key: 'runtime', label: 'settings.sections.runtime.label', hint: 'settings.sections.runtime.hint' },
]

export function SettingsDialog({ open, onOpenChange, onModelsChanged, executors = [] }: Props): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [section, setSection] = useState<SectionKey>('interface')

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: async (): Promise<ServerSettingsPayload> => {
      const r = await fetch('/settings', { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as ServerSettingsPayload
    },
    enabled: open,
    staleTime: 30_000,
  })
  const payload = settingsQuery.data ?? null
  const loadError = settingsQuery.error ? (settingsQuery.error as Error).message : null

  const applyPayload = (next: ServerSettingsPayload): void => {
    queryClient.setQueryData(['settings'], next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(90dvh,44rem)] max-w-6xl overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)]"
        data-testid="settings-dialog"
      >
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[200px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="min-h-0 border-b border-border/50 bg-muted/60 md:border-b-0 md:border-r">
            <ScrollArea className="h-full">
              <nav className="flex gap-1 p-2 md:block md:space-y-1" aria-label={t('settings.sectionsLabel')}>
                {SECTIONS.map((s) => (
                  <SettingsSectionButton key={s.key} section={s} active={section === s.key} onClick={() => setSection(s.key)} />
                ))}
              </nav>
            </ScrollArea>
          </aside>
          <ScrollArea className="min-h-0">
            <div className="p-4 sm:p-6">
              {loadError ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {t('settings.loadFailed', { error: loadError })}
                </div>
              ) : payload === null ? (
                <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
              ) : section === 'runtime' ? (
                <RuntimeSection payload={payload} />
              ) : section === 'connection' ? (
                <ConnectionSection />
              ) : section === 'models' ? (
                <ModelsSection payload={payload} onPayloadChange={applyPayload} onModelsChanged={onModelsChanged} />
              ) : section === 'security' ? (
                <SecuritySection payload={payload} />
              ) : section === 'executorAccess' ? (
                <ExecutorAccessSection />
              ) : section === 'approvals' ? (
                <ApprovalsSection />
              ) : section === 'hooks' ? (
                <HooksSection payload={payload} />
              ) : section === 'interface' ? (
                <InterfaceSection />
              ) : section === 'versions' ? (
                <VersionsSection payload={payload} executors={executors} />
              ) : (
                <McpSection payload={payload} />
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SettingsSectionButton({
  section,
  active,
  onClick,
}: {
  section: (typeof SECTIONS)[number]
  active: boolean
  onClick(): void
}): JSX.Element {
  const { t } = useTranslation()
  const label = t(`settings.sections.${section.key}.label`)
  const hint = t(`settings.sections.${section.key}.hint`)
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`settings-tab-${section.key}`}
      className={cn(
        'w-36 flex-none rounded-md px-3 py-2 text-left text-sm transition-colors md:w-full',
        active
          ? 'bg-primary/10 text-foreground shadow-inner ring-1 ring-primary/30'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <div className="font-medium">{label}</div>
      <div className="mt-0.5 hidden text-[11px] text-muted-foreground md:block">{hint}</div>
    </button>
  )
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}): JSX.Element {
  return (
    <div className="mb-4">
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {subtitle ? (
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function executorSetupCommand(inviteToken: string): string {
  const hostUrl = resolveHostEndpoint().url
  return `HOST_URL=${shellQuote(hostUrl)} EXECUTOR_INVITE=${shellQuote(inviteToken)} SANDBOX_ROOTS="$PWD" agent-kernel-executor`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function RuntimeSection({
  payload,
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  const { t } = useTranslation()
  const rows: Array<[string, string]> = [
    [t('settings.runtime.anthropicSettings'), payload.paths.claudeSettings],
    [t('settings.runtime.openaiProviders'), payload.paths.codexConfig],
    [t('settings.runtime.manualModels'), payload.paths.manualModels],
    [t('settings.runtime.hooksConfig'), payload.paths.hooksConfig],
    [t('settings.runtime.sessionsDirectory'), payload.paths.sessionsDir],
  ]
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.runtime.label')}
        subtitle={t('settings.runtime.subtitle')}
      />
      <div className="overflow-hidden rounded-md ring-1 ring-border/50">
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, path], i) => (
              <tr
                key={label}
                className={cn(
                  'border-border/50',
                  i !== rows.length - 1 && 'border-b',
                )}
              >
                <th className="w-56 border-r border-border/50 bg-muted/50 px-3 py-2.5 text-left font-medium">
                  {label}
                </th>
                <td className="px-3 py-2.5 font-mono text-xs">
                  <div className="flex items-center gap-2">
                    <span className="truncate" title={path}>{path}</span>
                    <CopyButton value={path} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function VersionsSection({
  payload,
  executors,
}: {
  payload: ServerSettingsPayload
  executors: readonly AttachedExecutor[]
}): JSX.Element {
  const { t } = useTranslation()
  const rows: Array<[string, string]> = [
    [t('settings.versions.dashboard'), DASHBOARD_VERSION],
    [t('settings.versions.host'), payload.versions?.host ?? '—'],
    [t('settings.versions.protocol'), payload.versions?.protocol ?? PROTOCOL_VERSION],
  ]
  return (
    <div>
      <SectionHeader title={t('settings.sections.versions.label')} subtitle={t('settings.versions.subtitle')} />
      <div className="overflow-hidden rounded-md ring-1 ring-border/50">
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, value], i) => (
              <tr key={label} className={cn('border-border/50', i !== rows.length - 1 && 'border-b')}>
                <th className="w-48 border-r border-border/50 bg-muted/50 px-3 py-2.5 text-left font-medium">{label}</th>
                <td className="px-3 py-2.5 font-mono text-xs">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-5">
        <h4 className="text-sm font-semibold text-foreground">{t('settings.versions.connectedExecutors')}</h4>
        <p className="mt-1 text-xs text-muted-foreground">{t('settings.versions.connectedExecutorsDesc')}</p>
        {executors.length === 0 ? (
          <EmptyRow>{t('settings.versions.noExecutors')}</EmptyRow>
        ) : (
          <div className="mt-3 overflow-hidden rounded-md ring-1 ring-border/50">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t('settings.versions.workspace')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('settings.versions.executor')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('settings.versions.executorVersion')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('settings.versions.executorProtocol')}</th>
                  <th className="px-3 py-2 text-left font-medium">{t('settings.versions.runtime')}</th>
                </tr>
              </thead>
              <tbody>
                {executors.map((executor, i) => (
                  <tr key={executor.executorId} className={cn('border-border/50', i !== executors.length - 1 && 'border-b')}>
                    <td className="max-w-44 px-3 py-2">
                      <div className="truncate font-medium" title={executor.workspaceName}>{executor.workspaceName}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground" title={executor.workspaceId}>{executor.workspaceId}</div>
                    </td>
                    <td className="max-w-44 truncate px-3 py-2 font-mono text-xs" title={executor.executorId}>{executor.executorId}</td>
                    <td className="px-3 py-2 font-mono text-xs">{executor.executorVersion ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{executor.clientVersion ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{executor.runtime} {executor.runtimeVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function SecuritySection({ payload }: { payload: ServerSettingsPayload }): JSX.Element {
  const { t } = useTranslation()
  const auth = payload.auth
  const inviteCount = auth?.executorIdentity.inviteCount ?? 0
  const rows: Array<[string, string]> = auth
    ? [
        [t('settings.security.dashboardAuth'), auth.dashboardAuthRequired ? t('settings.security.required') : t('settings.security.notRequired')],
        [t('settings.security.githubOAuth'), auth.githubOAuth.required ? (auth.githubOAuth.configured ? t('settings.security.requiredConfigured') : t('settings.security.requiredIncomplete')) : t('settings.security.disabled')],
        [t('settings.security.githubWhitelist'), auth.githubOAuth.usernameWhitelistEnabled ? auth.githubOAuth.usernameWhitelist.join(', ') : t('settings.security.disabled')],
        [t('settings.security.executorIdentity'), auth.executorIdentity.tokenScoped ? t('settings.security.tokenScoped', { count: auth.executorIdentity.tokenCount }) : auth.executorIdentity.tokenCount > 0 ? t('settings.security.tokenProtected', { count: auth.executorIdentity.tokenCount }) : t('settings.security.inviteReady')],
        [t('settings.security.executorInvites'), t('settings.security.inviteCount', { count: inviteCount })],
      ]
    : [
        [t('settings.security.dashboardAuth'), t('settings.security.notRequired')],
        [t('settings.security.githubOAuth'), t('settings.security.disabled')],
        [t('settings.security.executorIdentity'), t('settings.security.inviteReady')],
      ]
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.security.label')}
        subtitle={t('settings.security.subtitle')}
      />
      <div className="overflow-hidden rounded-md ring-1 ring-border/50">
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, value], i) => (
              <tr key={label} className={cn('border-border/50', i !== rows.length - 1 && 'border-b')}>
                <th className="w-56 border-r border-border/50 bg-muted/50 px-3 py-2.5 text-left font-medium">
                  {label}
                </th>
                <td className="px-3 py-2.5 text-sm text-muted-foreground">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 rounded-md bg-muted/40 px-4 py-3 text-xs text-muted-foreground ring-1 ring-border/50">
        <div className="font-mono">HOST_GITHUB_OAUTH_REQUIRED, GITHUB_USERNAME_WHITELIST, EXECUTOR_TOKENS, HOST_AUDIT_DIR</div>
      </div>
    </div>
  )
}

function ExecutorAccessSection(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [plainInvite, setPlainInvite] = useState<ServerExecutorInvitePayload | null>(null)
  const [copyMode, setCopyMode] = useState<'command' | 'token'>('command')
  const [error, setError] = useState<string | null>(null)

  const invitesQuery = useQuery({
    queryKey: ['executor-invites'],
    queryFn: async (): Promise<ServerExecutorInvitesPayload> => {
      const res = await fetch('/auth/executor-invites', { cache: 'no-store' })
      const body = await res.json() as ServerExecutorInvitesPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerExecutorInvitesPayload
    },
  })

  const createInvite = useMutation({
    mutationFn: async (): Promise<ServerExecutorInvitePayload> => {
      const input = { ...(label.trim() ? { label: label.trim() } : {}), ...(workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}) }
      const res = await fetch('/auth/executor-invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await res.json() as ServerExecutorInvitePayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerExecutorInvitePayload
    },
    onSuccess: (invite) => {
      setPlainInvite(invite)
      setLabel('')
      setWorkspaceId('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['executor-invites'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const patchInvite = useMutation({
    mutationFn: async (input: { id: string; label: string }): Promise<void> => {
      const res = await fetch(`/auth/executor-invites/${encodeURIComponent(input.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: input.label }),
      })
      if (!res.ok) throw new Error(await responseError(res))
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['executor-invites'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const revokeInvite = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/auth/executor-invites/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await responseError(res))
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['executor-invites'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const regenerateInvite = useMutation({
    mutationFn: async (id: string): Promise<ServerExecutorInvitePayload> => {
      const res = await fetch(`/auth/executor-invites/${encodeURIComponent(id)}/regenerate`, { method: 'POST' })
      const body = await res.json() as ServerExecutorInvitePayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerExecutorInvitePayload
    },
    onSuccess: (invite) => {
      setPlainInvite(invite)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['executor-invites'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const busy = createInvite.isPending || patchInvite.isPending || revokeInvite.isPending || regenerateInvite.isPending
  const invites = invitesQuery.data?.invites ?? []
  const inviteCopyValue = plainInvite
    ? copyMode === 'command'
      ? executorSetupCommand(plainInvite.inviteToken)
      : plainInvite.inviteToken
    : ''

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setError(null)
    createInvite.mutate()
  }

  const saveLabel = (invite: ExecutorInviteSummary): void => {
    const next = editing[invite.id] ?? invite.label ?? ''
    setError(null)
    patchInvite.mutate({ id: invite.id, label: next })
  }

  return (
    <div>
      <SectionHeader title={t('settings.sections.executorAccess.label')} subtitle={t('settings.executorAccess.subtitle')} />
      <form onSubmit={submit} className="mb-4 rounded-md bg-muted/30 p-3 ring-1 ring-border/50">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="text-xs font-medium text-muted-foreground">
            {t('settings.executorAccess.label')}
            <input
              className="mt-1 h-9 w-full rounded-md border-0 bg-background px-2 text-sm text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('settings.executorAccess.labelPlaceholder')}
              disabled={busy}
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            {t('settings.executorAccess.workspaceId')}
            <input
              className="mt-1 h-9 w-full rounded-md border-0 bg-background px-2 font-mono text-sm text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              placeholder={t('settings.executorAccess.workspacePlaceholder')}
              disabled={busy}
            />
          </label>
          <Button type="submit" className="mt-5 h-9" disabled={busy}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.executorAccess.create')}
          </Button>
        </div>
        {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
      </form>
      {plainInvite ? (
        <div className="mb-4 rounded-md bg-primary/5 px-3 py-2 ring-1 ring-primary/30">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-foreground">{t('settings.executorAccess.plaintextTitle')}</div>
            <select
              value={copyMode}
              onChange={(event) => setCopyMode(event.target.value === 'token' ? 'token' : 'command')}
              className="h-7 rounded-md bg-background px-2 text-xs text-foreground outline-none ring-1 ring-border/50"
              aria-label={t('settings.executorAccess.copyMode')}
            >
              <option value="command">{t('settings.executorAccess.copyCommand')}</option>
              <option value="token">{t('settings.executorAccess.copyToken')}</option>
            </select>
          </div>
          <div className="mt-1 flex items-center gap-2 rounded bg-background px-2 py-1.5 font-mono text-xs ring-1 ring-border/50">
            <span className="min-w-0 flex-1 truncate" title={inviteCopyValue}>{inviteCopyValue}</span>
            <CopyButton value={inviteCopyValue} />
          </div>
        </div>
      ) : null}
      {invitesQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : invites.length === 0 ? (
        <EmptyRow>{t('settings.executorAccess.empty')}</EmptyRow>
      ) : (
        <div className="overflow-hidden rounded-md ring-1 ring-border/50">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left [box-shadow:inset_0_-1px_0_hsl(var(--border)/0.5)]">{t('settings.executorAccess.label')}</th>
                <th className="px-3 py-2 text-left [box-shadow:inset_0_-1px_0_hsl(var(--border)/0.5)]">{t('settings.executorAccess.workspaceId')}</th>
                <th className="px-3 py-2 text-left [box-shadow:inset_0_-1px_0_hsl(var(--border)/0.5)]">{t('settings.executorAccess.lastUsed')}</th>
                <th className="px-3 py-2 text-left [box-shadow:inset_0_-1px_0_hsl(var(--border)/0.5)]">{t('settings.executorAccess.status')}</th>
                <th className="px-3 py-2 text-right [box-shadow:inset_0_-1px_0_hsl(var(--border)/0.5)]">{t('settings.executorAccess.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite, i) => (
                <tr key={invite.id} className={cn(i !== invites.length - 1 && '[box-shadow:inset_0_-1px_0_hsl(var(--border)/0.5)]')}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <input
                        className="h-8 min-w-0 rounded-md border-0 bg-background px-2 text-sm text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50 disabled:opacity-70"
                        value={editing[invite.id] ?? invite.label ?? ''}
                        onChange={(event) => setEditing((prev) => ({ ...prev, [invite.id]: event.target.value }))}
                        onBlur={() => saveLabel(invite)}
                        placeholder={t('settings.executorAccess.untitled')}
                        disabled={busy || invite.revoked}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{invite.workspaceId ?? t('settings.executorAccess.unbound')}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{invite.lastUsedAt ? formatDate(invite.lastUsedAt) : t('settings.executorAccess.never')}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className={cn('rounded px-1.5 py-0.5 ring-1', invite.revoked ? 'bg-destructive/10 text-destructive ring-destructive/40' : 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300')}>
                      {invite.revoked ? t('settings.executorAccess.revoked') : t('settings.executorAccess.active')}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => regenerateInvite.mutate(invite.id)} disabled={busy} aria-label={t('settings.executorAccess.regenerate')}>
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => revokeInvite.mutate(invite.id)} disabled={busy || invite.revoked} aria-label={t('settings.executorAccess.revoke')}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ModelsSection({
  payload,
  onPayloadChange,
  onModelsChanged,
}: {
  payload: ServerSettingsPayload
  onPayloadChange(payload: ServerSettingsPayload): void
  onModelsChanged?(): void
}): JSX.Element {
  const { t } = useTranslation()
  const [providerId, setProviderId] = useState(payload.providers[0]?.id ?? '')
  const [modelId, setModelId] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!payload.providers.some((p) => p.id === providerId)) {
      setProviderId(payload.providers[0]?.id ?? '')
    }
  }, [payload.providers, providerId])

  const addModel = useMutation({
    mutationFn: async (input: { providerId: string; id: string; label?: string }): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      onModelsChanged?.()
      setModelId('')
      setLabel('')
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const deleteModel = useMutation({
    mutationFn: async (input: { providerId: string; id: string }): Promise<ServerSettingsPayload> => {
      const params = new URLSearchParams({ providerId: input.providerId, id: input.id })
      const res = await fetch(`/settings/models?${params.toString()}`, { method: 'DELETE' })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      onModelsChanged?.()
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const busy = addModel.isPending || deleteModel.isPending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setError(null)
    const trimmedLabel = label.trim()
    addModel.mutate({
      providerId,
      id: modelId.trim(),
      ...(trimmedLabel ? { label: trimmedLabel } : {}),
    })
  }

  const deleteManual = (deleteProviderId: string, id: string): void => {
    setError(null)
    deleteModel.mutate({ providerId: deleteProviderId, id })
  }

  return (
    <div>
      <SectionHeader
        title={t('settings.sections.models.label')}
        subtitle={t('settings.models.subtitle')}
      />
      <form onSubmit={submit} className="mb-4 rounded-md bg-muted/30 p-3 ring-1 ring-border/50">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="text-xs font-medium text-muted-foreground">
            {t('settings.models.provider')}
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              disabled={payload.providers.length === 0 || busy}
              data-testid="settings-model-provider-select"
            >
              {payload.providers.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            {t('settings.models.modelId')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="gpt-5.5-mini"
              disabled={payload.providers.length === 0 || busy}
              data-testid="settings-model-id-input"
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            {t('settings.models.label')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('settings.models.optional')}
              disabled={payload.providers.length === 0 || busy}
            />
          </label>
          <Button type="submit" className="mt-5 h-9" disabled={payload.providers.length === 0 || busy || modelId.trim().length === 0}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.models.add')}
          </Button>
        </div>
        {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
        <div className="mt-2 text-xs text-muted-foreground">
          <Trans i18nKey="settings.models.manualStored" values={{ path: payload.paths.manualModels }} components={{ code: <code className="font-mono" /> }} />
        </div>
      </form>
      {payload.providers.length === 0 ? (
        <EmptyRow>
          {t('settings.models.noProvider', { claudePath: payload.paths.claudeSettings, codexPath: payload.paths.codexConfig })}
        </EmptyRow>
      ) : (
        <div className="space-y-4">
          {payload.providers.map((p) => (
            <div
              key={p.id}
              className="rounded-md bg-card/60 p-4 ring-1 ring-border/50"
              data-testid={`settings-provider-${p.id}`}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-mono">{p.wire}</span>
                    {' · '}
                    <SourceBadge source={p.source ?? 'unknown'} />
                    {p.baseUrl ? (
                      <>
                        {' · '}
                        <span className="font-mono">{p.baseUrl}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                {p.models.some((m) => m.id === payload.defaultModel) ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground ring-1 ring-primary/40">
                    {t('settings.models.defaultProvider')}
                  </span>
                ) : null}
              </div>
              {p.models.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  {t('settings.models.noModelAttached')}
                </div>
              ) : (
                <ul className="space-y-1">
                  {p.models.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2.5 py-1.5 text-xs ring-1 ring-border/50"
                    >
                      <span className="min-w-0 truncate font-mono">{m.id}</span>
                      <span className="flex flex-none items-center gap-2">
                        <SourceBadge source={m.source ?? p.source ?? 'unknown'} />
                        {m.id === payload.defaultModel ? (
                          <span className="text-[10px] font-medium uppercase tracking-wide text-primary">
                            {t('settings.models.default')}
                          </span>
                        ) : null}
                        {m.source === 'manual' ? (
                          <button
                            type="button"
                            onClick={() => { deleteManual(p.id, m.id) }}
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t('settings.models.deleteModel', { model: m.id })}
                            disabled={busy}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SourceBadge({ source }: { source: string }): JSX.Element {
  const label = source === 'claude-settings'
    ? 'Claude Code'
    : source === 'codex-config'
      ? 'Codex'
      : source === 'env'
        ? 'Env'
        : source === 'manual'
          ? 'Manual'
          : 'Unknown'
  return (
    <span className="rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground ring-1 ring-border/50">
      {label}
    </span>
  )
}

function ApprovalsSection(): JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.approvals.label')}
        subtitle={t('settings.approvals.subtitle')}
      />
      <ul className="space-y-2 text-sm">
        <li>
          <b>{t('composer.approvalModes.auto.label')}</b> - {t('settings.approvals.auto')}
        </li>
        <li>
          <b>{t('composer.approvalModes.ask.label')}</b> - {t('settings.approvals.ask')}
        </li>
        <li>
          <b>{t('composer.approvalModes.deny.label')}</b> - {t('settings.approvals.deny')}
        </li>
        <li>
          <b>{t('composer.approvalModes.allowAll.label')}</b> - {t('settings.approvals.allowAll')}{' '}
          <code className="font-mono">AK_ALLOW_ALL_OK=1</code>.
        </li>
      </ul>
    </div>
  )
}

function HooksSection({
  payload,
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.hooks.label')}
        subtitle={t('settings.hooks.subtitle')}
      />
      {payload.hooks.length === 0 ? (
        <EmptyRow>
          {t('settings.hooks.none', { path: payload.paths.hooksConfig })}
        </EmptyRow>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="border-b border-border/50 px-3 py-2 text-left">{t('settings.hooks.event')}</th>
                <th className="border-b border-border/50 px-3 py-2 text-left">{t('settings.hooks.match')}</th>
                <th className="border-b border-border/50 px-3 py-2 text-left">{t('settings.hooks.command')}</th>
              </tr>
            </thead>
            <tbody>
              {payload.hooks.map((h, i) => (
                <tr
                  key={i}
                  className={cn(
                    'border-border/50',
                    i !== payload.hooks.length - 1 && 'border-b',
                  )}
                >
                  <td className="px-3 py-2 font-mono text-xs">{h.event}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {h.match ?? '*'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span className="truncate" title={h.command}>{h.command}</span>
                      <CopyButton value={h.command} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">{t('settings.hooks.example')}</summary>
        <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-foreground">
{`[[hooks]]
event = "pre_tool_use"
match = "bash"
command = "/usr/local/bin/lint-shell.sh"`}
        </pre>
      </details>
    </div>
  )
}

function InterfaceSection(): JSX.Element {
  const { t } = useTranslation()
  const [showToolCallTab, setShowToolCallTab] = useBooleanPref(PREF_SHOW_TOOL_CALL_TAB, true)
  const [explorerOpen, setExplorerOpen] = useBooleanPref(PREF_EXPLORER_OPEN, true)
  const [inspectorOpen, setInspectorOpen] = useBooleanPref(PREF_INSPECTOR_OPEN, true)
  const [topbarOpen, setTopbarOpen] = useBooleanPref(PREF_TOPBAR_OPEN, true)
  const [liveToolActivityTail, setLiveToolActivityTail] = useNumberPref(
    PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
    DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
    { min: 0, max: 10 },
  )
  const [theme, , setTheme] = useTheme()
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.interface.label')}
        subtitle={t('settings.interface.subtitle')}
      />
      <ul className="space-y-3 text-sm">
        <li className="flex items-start justify-between gap-4 rounded-md bg-card/60 px-4 py-3 ring-1 ring-border/50">
          <div className="min-w-0">
            <div className="font-medium">{t('settings.interface.theme.label')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.interface.theme.desc')}
            </p>
          </div>
          <div
            role="radiogroup"
            aria-label={t('settings.interface.theme.label')}
            className="inline-flex flex-none overflow-hidden rounded-md border border-border"
            data-testid="settings-theme-toggle"
          >
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'system'}
              onClick={() => setTheme('system')}
              data-testid="settings-theme-system"
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs',
                theme === 'system'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Monitor className="h-3.5 w-3.5" aria-hidden />
              <span>{t('settings.interface.theme.system')}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'dark'}
              onClick={() => setTheme('dark')}
              data-testid="settings-theme-dark"
              className={cn(
                'inline-flex items-center gap-1.5 border-l border-border px-3 py-1.5 text-xs',
                theme === 'dark'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Moon className="h-3.5 w-3.5" aria-hidden />
              <span>{t('settings.interface.theme.dark')}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'light'}
              onClick={() => setTheme('light')}
              data-testid="settings-theme-light"
              className={cn(
                'inline-flex items-center gap-1.5 border-l border-border px-3 py-1.5 text-xs',
                theme === 'light'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Sun className="h-3.5 w-3.5" aria-hidden />
              <span>{t('settings.interface.theme.light')}</span>
            </button>
          </div>
        </li>
        <li className="flex items-start justify-between gap-4 rounded-md border border-border bg-card/60 px-4 py-3">
          <div className="min-w-0">
            <div className="font-medium">{t('settings.interface.showToolCallTab')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.interface.showToolCallTabDesc')}
            </p>
          </div>
          <Toggle
            checked={showToolCallTab}
            onChange={setShowToolCallTab}
            ariaLabel={t('settings.interface.showToolCallTab')}
            testId="settings-toggle-tool-call-tab"
          />
        </li>
        <InterfaceToggle
          label={t('settings.interface.explorerOpen')}
          description={t('settings.interface.explorerOpenDesc')}
          checked={explorerOpen}
          onChange={setExplorerOpen}
          testId="settings-toggle-explorer-open"
        />
        <InterfaceToggle
          label={t('settings.interface.inspectorOpen')}
          description={t('settings.interface.inspectorOpenDesc')}
          checked={inspectorOpen}
          onChange={setInspectorOpen}
          testId="settings-toggle-inspector-open"
        />
        <InterfaceToggle
          label={t('settings.interface.topbarOpen')}
          description={t('settings.interface.topbarOpenDesc')}
          checked={topbarOpen}
          onChange={setTopbarOpen}
          testId="settings-toggle-topbar-open"
        />
        <li className="flex items-start justify-between gap-4 rounded-md border border-border bg-card/60 px-4 py-3">
          <div className="min-w-0">
            <div className="font-medium">{t('settings.interface.liveToolActivityTail')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.interface.liveToolActivityTailDesc')}
            </p>
          </div>
          <input
            type="number"
            min={0}
            max={10}
            step={1}
            value={liveToolActivityTail}
            onChange={(event) => setLiveToolActivityTail(Number(event.currentTarget.value))}
            className="h-8 w-20 flex-none rounded-md bg-background px-2 text-sm ring-1 ring-border/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('settings.interface.liveToolActivityTail')}
            data-testid="settings-live-tool-activity-tail"
          />
        </li>
        <DesktopNotificationsSettings />
      </ul>
    </div>
  )
}

function InterfaceToggle({
  label,
  description,
  checked,
  onChange,
  testId,
}: {
  label: string
  description: string
  checked: boolean
  onChange(next: boolean): void
  testId: string
}): JSX.Element {
  return (
    <li className="flex items-start justify-between gap-4 rounded-md border border-border bg-card/60 px-4 py-3">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} ariaLabel={label} testId={testId} />
    </li>
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
      <div className="flex items-start justify-between gap-4">
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
    <div className="flex items-center justify-between gap-4 rounded-md bg-muted/30 px-3 py-2">
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

function permissionLabel(permission: NotificationPermission | 'unsupported', t: ReturnType<typeof useTranslation>['t']): string {
  if (permission === 'default') return t('settings.interface.permissionDefault')
  if (permission === 'unsupported') return t('settings.interface.permissionUnsupported')
  return permission
}

async function responseError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string }
    return body.error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function Toggle({
  checked,
  onChange,
  ariaLabel,
  testId,
  disabled = false,
}: {
  checked: boolean
  onChange(next: boolean): void
  ariaLabel: string
  testId?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

function McpSection({
  payload,
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.mcp.label')}
        subtitle={t('settings.mcp.subtitle')}
      />
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <div className="mb-1 font-medium text-foreground">{t('settings.mcp.notImplemented')}</div>
        <p className="text-muted-foreground">{payload.mcp.note}</p>
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        {t('settings.mcp.body')}
      </p>
      <div className="mt-4 flex items-center gap-2 text-sm">
        <a
          href="https://modelcontextprotocol.io"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          Model Context Protocol
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function CopyButton({ value }: { value: string }): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Non-fatal — clipboard permission denied.
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-6 w-6 flex-none text-muted-foreground hover:text-foreground"
      aria-label={copied ? t('settings.copy.copied') : t('settings.copy.copyValue')}
      onClick={() => {
        void copy()
      }}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  )
}

function ConnectionSection(): JSX.Element {
  const [current, setCurrent] = useState(() => resolveHostEndpoint())
  const [draft, setDraft] = useState<string>(() => getStoredHostEndpoint() ?? '')
  const [testState, setTestState] = useState<{ kind: 'idle' | 'testing' | 'ok' | 'error'; msg?: string }>({ kind: 'idle' })

  useEffect(() => {
    const refresh = () => setCurrent(resolveHostEndpoint())
    window.addEventListener('agent-kernel:host-endpoint-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('agent-kernel:host-endpoint-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const sourceLabel: Record<typeof current.source, string> = {
    query: 'URL ?host= param (temporary override)',
    settings: 'Saved in this browser',
    build: 'Baked in at build time (VITE_AGENT_KERNEL_HOST)',
    default: 'Same origin (default)',
  }

  const save = () => {
    setStoredHostEndpoint(draft.trim() === '' ? null : draft.trim())
    setTestState({ kind: 'idle' })
  }
  const reset = () => {
    setStoredHostEndpoint(null)
    setDraft('')
    setTestState({ kind: 'idle' })
  }
  const test = async () => {
    const target = draft.trim() === '' ? window.location.origin : draft.trim().replace(/\/+$/, '')
    setTestState({ kind: 'testing' })
    try {
      const res = await fetch(`${target}/models`, { method: 'GET' })
      if (!res.ok) {
        setTestState({ kind: 'error', msg: `HTTP ${res.status}` })
        return
      }
      setTestState({ kind: 'ok', msg: 'reachable' })
    } catch (err) {
      setTestState({ kind: 'error', msg: err instanceof Error ? err.message : 'unreachable' })
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="Host endpoint" subtitle="Where this dashboard connects for Socket.IO, models, and settings." />

      <div className="space-y-3 rounded border border-border p-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Currently used</div>
          <div className="mt-1 font-mono">{current.url || '(none)'}</div>
          <div className="mt-1 text-xs text-muted-foreground">Source: {sourceLabel[current.source]}</div>
        </div>
        <div className="text-xs text-muted-foreground">
          Priority: URL ?host= &gt; saved in browser &gt; build-time env &gt; same origin.
        </div>
      </div>

      <div className="space-y-3">
        <label className="block text-sm font-medium">Override host endpoint</label>
        <input
          type="url"
          className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm"
          placeholder={window.location.origin}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="text-xs text-muted-foreground">
          Leave empty to fall back to the default. Cross-origin endpoints require the host to set
          {' '}<code className="rounded bg-muted px-1">AGENT_KERNEL_ALLOWED_ORIGINS</code>.
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={save}>Save</Button>
          <Button size="sm" variant="outline" onClick={() => void test()} disabled={testState.kind === 'testing'}>
            {testState.kind === 'testing' ? 'Testing…' : 'Test connection'}
          </Button>
          <Button size="sm" variant="ghost" onClick={reset}>Reset to default</Button>
        </div>
        {testState.kind === 'ok' && (
          <div className="text-xs text-emerald-500">✓ {testState.msg}</div>
        )}
        {testState.kind === 'error' && (
          <div className="text-xs text-red-500">✗ {testState.msg}</div>
        )}
      </div>
    </div>
  )
}
