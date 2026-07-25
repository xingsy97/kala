import { useEffect, useState, type FormEvent } from 'react'
import {
  Bell,
  Blocks,
  Bot,
  Cable,
  Check,
  Copy,
  Cpu,
  Eye,
  ExternalLink,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Palette,
  PlugZap,
  Plus,
  RefreshCw,
  Rocket,
  ServerCog,
  Shield,
  SlidersHorizontal,
  Sun,
  TerminalSquare,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AttachedExecutor, BuildMetadata, ExecutorInviteSummary, ServerExecutorInvitePayload, ServerExecutorInvitesPayload, ServerSettingsPayload } from '@agent-kernel/shared'
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
  DEFAULT_CHAT_CONTENT_WIDTH,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CHAT_LINE_HEIGHT,
  DEFAULT_CHAT_MATH_SCALE,
  DEFAULT_CHAT_SIDE_SPACE,
  DEFAULT_FILE_EXPLORER_FONT_SIZE,
  DEFAULT_FILE_VIEW_FONT_SIZE,
  DEFAULT_SESSION_EXPLORER_FONT_SIZE,
  PREF_CHAT_CONTENT_WIDTH,
  PREF_CHAT_FONT_SIZE,
  PREF_CHAT_LINE_HEIGHT,
  PREF_CHAT_MATH_SCALE,
  PREF_CHAT_SIDE_SPACE,
  PREF_FILE_EXPLORER_FONT_SIZE,
  PREF_FILE_VIEW_FONT_SIZE,
  PREF_EXPLORER_OPEN,
  PREF_INSPECTOR_OPEN,
  PREF_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  PREF_SESSION_EXPLORER_FONT_SIZE,
  PREF_SHOW_TOOL_CALL_TAB,
  PREF_TOPBAR_OPEN,
  PREF_DURABLE_SESSION_CACHE_ENABLED,
  PREF_APP_BADGE_ENABLED,
  PREF_KEEP_SCREEN_AWAKE,
  useBooleanPref,
  useNumberPref,
} from '../../lib/prefs.js'
import {
  DEFAULT_SESSION_VIEW_CACHE_MAX_MB,
  PREF_SESSION_VIEW_CACHE_MAX_MB,
} from '../../session-view-cache.js'
import { useTheme } from '../../lib/theme.js'
import type { DurableSessionViewCache } from '../../durable-session-cache.js'
import { appBadgeSupported } from '../../lib/app-badge.js'
import { wakeLockSupported } from '../../lib/wake-lock.js'
import {
  BUILTIN_VSCODE_THEMES,
  builtinThemeForScheme,
  readStoredVSCodeTheme,
  validateVSCodeTheme,
  writeStoredVSCodeTheme,
  applyVSCodeTheme,
  applyCurrentVSCodeTheme,
  type StoredVSCodeTheme,
} from '../../theme/vscode-theme.js'
import { getStoredHostEndpoint, resolveHostEndpoint, setStoredHostEndpoint } from '../../host-endpoint.js'
import {
  DESKTOP_NOTIFICATION_PREFS,
  PREF_DESKTOP_NOTIFICATIONS_ENABLED,
  PREF_DESKTOP_NOTIFICATION_SOUND,
  notificationPermission,
  requestNotificationPermission,
} from '../../lib/desktop-notifications.js'
import {
  currentPushEndpoint,
  detectPushSupport,
  subscribeToPush,
  unsubscribeFromPush,
  type PushSupport,
} from '../../lib/push.js'
import type { DesktopNotificationKind } from '@agent-kernel/shared/push'
import packageJson from '../../../package.json'

const DASHBOARD_VERSION = packageJson.version

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  onModelsChanged?(): void
  executors?: readonly AttachedExecutor[]
  sessionCache?: DurableSessionViewCache
}

function errorMessageFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const error = (body as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0 ? error : null
}

type SectionKey = 'runtime' | 'connection' | 'agent' | 'models' | 'security' | 'socketAdmin' | 'executorAccess' | 'approvals' | 'hooks' | 'mcp' | 'interface' | 'deployment' | 'notifications'

const SECTIONS: readonly { key: SectionKey; label: string; hint: string; icon: LucideIcon }[] = [
  { key: 'connection', label: 'settings.sections.connection.label', hint: 'settings.sections.connection.hint', icon: Cable },
  { key: 'agent', label: 'settings.sections.agent.label', hint: 'settings.sections.agent.hint', icon: Bot },
  { key: 'models', label: 'settings.sections.models.label', hint: 'settings.sections.models.hint', icon: Cpu },
  { key: 'approvals', label: 'settings.sections.approvals.label', hint: 'settings.sections.approvals.hint', icon: KeyRound },
  { key: 'executorAccess', label: 'settings.sections.executorAccess.label', hint: 'settings.sections.executorAccess.hint', icon: TerminalSquare },
  { key: 'interface', label: 'settings.sections.interface.label', hint: 'settings.sections.interface.hint', icon: Palette },
  { key: 'security', label: 'settings.sections.security.label', hint: 'settings.sections.security.hint', icon: Shield },
  { key: 'socketAdmin', label: 'settings.sections.socketAdmin.label', hint: 'settings.sections.socketAdmin.hint', icon: ServerCog },
  { key: 'hooks', label: 'settings.sections.hooks.label', hint: 'settings.sections.hooks.hint', icon: PlugZap },
  { key: 'runtime', label: 'settings.sections.runtime.label', hint: 'settings.sections.runtime.hint', icon: SlidersHorizontal },
  { key: 'deployment', label: 'settings.sections.deployment.label', hint: 'settings.sections.deployment.hint', icon: Rocket },
  { key: 'mcp', label: 'settings.sections.mcp.label', hint: 'settings.sections.mcp.hint', icon: Blocks },
  { key: 'notifications', label: 'settings.sections.notifications.label', hint: 'settings.sections.notifications.hint', icon: Bell },
]

export function SettingsDialog({ open, onOpenChange, onModelsChanged, executors = [], sessionCache }: Props): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [section, setSection] = useState<SectionKey>('connection')

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
        className="h-[calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom)-0.5rem)] max-w-4xl overflow-hidden border-border bg-background p-0 text-foreground shadow-2xl gap-0 grid-rows-[auto_minmax(0,1fr)] sm:h-[min(90dvh,44rem)] [&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_select]:border-border [&_select]:bg-background [&_select]:text-foreground [&_table]:bg-muted/20 [&_td]:text-foreground [&_textarea]:border-border [&_textarea]:bg-background [&_textarea]:text-foreground [&_th]:bg-muted/50 [&_th]:text-foreground"
        data-testid="settings-dialog"
      >
        <DialogHeader className="border-b border-border bg-card px-4 py-3 sm:px-5">
          <DialogTitle className="text-base font-semibold text-foreground">{t('settings.title')}</DialogTitle>
          <DialogDescription className="line-clamp-2 text-xs text-muted-foreground sm:line-clamp-none">
            {t('settings.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[200px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="min-h-0 min-w-0 border-b border-border bg-sidebar md:border-b-0 md:border-r">
            <nav className="flex w-full max-w-full gap-1 overflow-x-auto p-2 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:block md:h-full md:space-y-1 md:overflow-x-hidden md:overflow-y-auto md:p-3" aria-label={t('settings.sectionsLabel')}>
              {SECTIONS.map((s) => (
                <SettingsSectionButton key={s.key} section={s} active={section === s.key} onClick={() => setSection(s.key)} />
              ))}
            </nav>
          </aside>
          <ScrollArea
            className="min-h-0 min-w-0 max-w-full overflow-x-hidden bg-background"
            viewportClassName="[&>div]:!block [&>div]:!w-full [&>div]:!min-w-0 [&>div]:!max-w-full"
          >
            <div className="min-w-0 max-w-full overflow-x-hidden p-4 text-foreground sm:p-7" data-testid="settings-responsive-content">
              {loadError ? (
                <div className="rounded-md border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {t('settings.loadFailed', { error: loadError })}
                </div>
              ) : payload === null ? (
                <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
              ) : section === 'runtime' ? (
                <RuntimeSection payload={payload} />
              ) : section === 'connection' ? (
                <ConnectionSection />
              ) : section === 'agent' ? (
                <AgentSection payload={payload} onPayloadChange={applyPayload} />
              ) : section === 'models' ? (
                <ModelsSection payload={payload} onPayloadChange={applyPayload} onModelsChanged={onModelsChanged} />
              ) : section === 'security' ? (
                <SecuritySection payload={payload} />
              ) : section === 'socketAdmin' ? (
                <SocketAdminSection payload={payload} onPayloadChange={applyPayload} />
              ) : section === 'executorAccess' ? (
                <ExecutorAccessSection />
              ) : section === 'approvals' ? (
                <ApprovalsSection />
              ) : section === 'hooks' ? (
                <HooksSection payload={payload} />
              ) : section === 'interface' ? (
                <InterfaceSection sessionCache={sessionCache} />
              ) : section === 'deployment' ? (
                <DeploymentSection payload={payload} executors={executors} />
              ) : section === 'notifications' ? (
                <NotificationsSection />
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
  const Icon = section.icon
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`settings-tab-${section.key}`}
      className={cn(
        'w-32 flex-none rounded-md px-3 py-2 text-left text-sm transition-colors sm:w-36 md:w-full',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-sm ring-1 ring-sidebar-border'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn('h-4 w-4 flex-none', active ? 'text-sidebar-accent-foreground' : 'text-sidebar-foreground/60')} aria-hidden="true" />
        <div className="min-w-0 truncate font-medium">{label}</div>
      </div>
      <div className="mt-1 hidden truncate pl-6 text-[11px] text-sidebar-foreground/50 md:block">{hint}</div>
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
    <div className="mb-6 min-w-0 border-b border-border pb-5">
      <h3 className="text-2xl font-semibold text-foreground">{title}</h3>
      {subtitle ? (
        <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function executorSetupCommand(inviteToken: string): string {
  const hostUrl = resolveHostEndpoint().url
  return `HOST_URL=${shellQuote(hostUrl)} EXECUTOR_INVITE=${shellQuote(inviteToken)} SANDBOX_ROOTS="$HOME" agent-kernel-executor`
}

function meaningfulInviteLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim()
  if (!trimmed) return undefined
  if (trimmed.toLocaleLowerCase() === 'connect workspace') return undefined
  return trimmed
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
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const restart = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const res = await fetch('/runtime/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'checkpoint', reason: 'manual' }),
      })
      const body = await res.json() as unknown | { error?: string }
      if (!res.ok) throw new Error(errorMessageFromBody(body) ?? `HTTP ${res.status}`)
      return body
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  const abortRestart = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const res = await fetch('/runtime/restart/abort', { method: 'POST' })
      const body = await res.json() as unknown
      if (!res.ok) throw new Error(errorMessageFromBody(body) ?? `HTTP ${res.status}`)
      return body
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  const rows: Array<[string, string]> = [
    [t('settings.runtime.anthropicSettings'), payload.paths.claudeSettings],
    [t('settings.runtime.openaiProviders'), payload.paths.codexConfig],
    [t('settings.runtime.manualModels'), payload.paths.manualModels],
    [t('settings.runtime.hooksConfig'), payload.paths.hooksConfig],
    [t('settings.runtime.sessionsDirectory'), payload.paths.sessionsDir],
  ]
  const runtime = payload.runtime
  const currentAttempt = runtime?.current
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.runtime.label')}
        subtitle={t('settings.runtime.subtitle')}
      />
      {runtime ? (
        <div className="mb-4 rounded-md bg-black/[0.18] p-4 ring-1 ring-white/10">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="min-w-0 space-y-1 text-sm">
              <div className="font-medium text-foreground">{t('settings.runtime.hostRuntime')}</div>
              <div className="text-xs text-muted-foreground">PID {runtime.pid} - {t('settings.runtime.startedAt')}: {runtime.startedAt}</div>
              <div className="text-xs text-muted-foreground">
                {t('settings.runtime.restartPhase')}: {currentAttempt?.phase ?? t('settings.runtime.restartIdle')}
                {currentAttempt ? ` - ${currentAttempt.sessions.length} ${t('settings.runtime.restartSessions')}` : ''}
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" size="sm" className="h-9" disabled={restart.isPending || Boolean(currentAttempt)} onClick={() => restart.mutate()}>
                <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.runtime.restartHost')}
              </Button>
              {currentAttempt ? (
                <Button type="button" variant="outline" size="sm" className="h-9" disabled={abortRestart.isPending} onClick={() => abortRestart.mutate()}>
                  {t('settings.runtime.abortRestart')}
                </Button>
              ) : null}
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('settings.runtime.restartDesc')}</p>
          {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
        </div>
      ) : null}
      <SettingsKeyValueList
        testId="settings-runtime-paths"
        rows={rows.map(([label, path]) => ({
          label,
          value: (
            <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
              <span className="min-w-0 flex-1 break-all" title={path}>{path}</span>
              <CopyButton value={path} />
            </div>
          ),
        }))}
      />
    </div>
  )
}

function AgentSection({
  payload,
  onPayloadChange,
}: {
  payload: ServerSettingsPayload
  onPayloadChange(payload: ServerSettingsPayload): void
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const agentPrompt = payload.agentPrompt

  const updatePreset = useMutation({
    mutationFn: async (preset: string): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/agent-prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preset }),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      return body as ServerSettingsPayload
    },
    onSuccess: (next) => {
      onPayloadChange(next)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  return (
    <div>
      <SectionHeader title={t('settings.sections.agent.label')} subtitle={t('settings.agent.subtitle')} />
      {!agentPrompt ? (
        <EmptyRow>{t('settings.agent.unavailable')}</EmptyRow>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {agentPrompt.presets.map((preset) => {
              const selected = preset.id === agentPrompt.selectedPreset
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={cn(
                    'min-h-28 rounded-md border p-4 text-left transition-colors',
                    selected
                      ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                      : 'border-border bg-card/60 hover:bg-accent/60',
                  )}
                  onClick={() => {
                    setError(null)
                    if (!selected) updatePreset.mutate(preset.id)
                  }}
                  disabled={updatePreset.isPending}
                  data-testid={`settings-agent-preset-${preset.id}`}
                  aria-pressed={selected}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-foreground">{preset.label}</div>
                    {selected ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{preset.description}</p>
                </button>
              )
            })}
          </div>
          {error ? <div className="text-xs text-destructive">{error}</div> : null}
          <div className="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground ring-1 ring-border/50">
            <div>{t('settings.agent.appliesToNewSessions')}</div>
            <div className="mt-1 break-all font-mono">{agentPrompt.configPath}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function DeploymentSection({
  payload,
  executors,
}: {
  payload: ServerSettingsPayload
  executors: readonly AttachedExecutor[]
}): JSX.Element {
  const { t } = useTranslation()
  const build = payload.versions?.build
  const rows: Array<{
    component: string
    detail?: string
    version: string
    commit: string
    builtAt: string
    instance: string
    health: string
  }> = [
    {
      component: t('settings.deployment.hostRuntime'),
      detail: hostDeliveryLabel(build),
      version: payload.versions?.host ?? '—',
      commit: build?.gitCommit ?? 'unknown',
      builtAt: build?.builtAt ?? 'unknown',
      instance: typeof window === 'undefined' ? t('settings.deployment.sameOriginHost') : window.location.host,
      health: t('settings.deployment.running'),
    },
    {
      component: t('settings.deployment.dashboardComponent'),
      detail: dashboardDeliveryLabel(build),
      version: DASHBOARD_VERSION,
      commit: build?.gitCommit ?? 'unknown',
      builtAt: build?.builtAt ?? 'unknown',
      instance: t('settings.deployment.embeddedInHost'),
      health: t('settings.deployment.loaded'),
    },
    {
      component: t('settings.deployment.protocolComponent'),
      detail: t('settings.deployment.wireContract'),
      version: payload.versions?.protocol ?? PROTOCOL_VERSION,
      commit: '—',
      builtAt: '—',
      instance: t('settings.deployment.sharedByComponents'),
      health: t('settings.deployment.compatible'),
    },
    ...executors.map((executor) => ({
      component: `${t('settings.deployment.executorComponent')}: ${executor.workspaceName}`,
      detail: executor.build ? executorDeliveryLabel(executor.build) : t('settings.deployment.legacyExecutor'),
      version: executor.executorVersion ?? t('settings.deployment.notReported'),
      commit: executor.build?.gitCommit ?? t('settings.deployment.notReported'),
      builtAt: executor.build?.builtAt ?? t('settings.deployment.notReported'),
      instance: executorInstanceLabel(executor),
      health: executorHealthLabel(executor, t('settings.deployment.connected'), t('settings.deployment.legacyMetadataMissing')),
    })),
  ]
  return (
    <div>
      <SectionHeader title={t('settings.sections.deployment.label')} subtitle={t('settings.deployment.subtitle')} />
      {payload.socketConnections ? (
        <div className="mb-4 rounded-md border border-border bg-card/60 px-4 py-3 text-sm" data-testid="settings-socket-connections">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="font-medium text-foreground">{t('settings.deployment.socketConnections')}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t('settings.deployment.socketConnectionsDesc', {
                  total: payload.socketConnections.total,
                  dashboard: payload.socketConnections.dashboard,
                  executor: payload.socketConnections.executor,
                  other: payload.socketConnections.other,
                })}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground sm:justify-end">
              {payload.socketConnections.namespaces.map((entry) => (
                <span key={entry.namespace} className="rounded border border-border bg-background/70 px-2 py-1 font-mono">
                  {t('settings.deployment.namespaceConnections', { namespace: entry.namespace, sockets: entry.sockets })}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <h4 className="mb-2 text-sm font-semibold text-foreground">{t('settings.deployment.componentInventory')}</h4>
      <SettingsRecordList testId="settings-component-inventory">
        {rows.map((row) => (
          <SettingsRecord key={row.component} title={row.component} detail={row.detail}>
            <SettingsRecordField label={t('settings.deployment.version')} mono>{row.version}</SettingsRecordField>
            <SettingsRecordField label={t('settings.deployment.commit')} mono>{row.commit}</SettingsRecordField>
            <SettingsRecordField label={t('settings.deployment.buildTime')} mono>{row.builtAt}</SettingsRecordField>
            <SettingsRecordField label={t('settings.deployment.instance')} mono>{row.instance}</SettingsRecordField>
            <SettingsRecordField label={t('settings.deployment.health')}>{row.health}</SettingsRecordField>
          </SettingsRecord>
        ))}
      </SettingsRecordList>
      {payload.agentModule ? (
        <div className="mt-5 rounded-md bg-muted/30 p-3 ring-1 ring-border/50">
          <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-foreground">Agent module</h4>
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={`${payload.agentModule.id}@${payload.agentModule.version}`}>
                {payload.agentModule.label} · {payload.agentModule.id}@{payload.agentModule.version}
              </div>
            </div>
            <div className="w-full min-w-0 text-left font-mono text-[11px] text-muted-foreground sm:w-auto sm:flex-none sm:text-right">
              <div>prompt {payload.agentModule.systemPromptHash.slice(0, 12)}</div>
              <div>tools {payload.agentModule.toolRegistryHash.slice(0, 12)}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {payload.agentModule.toolsets.map((toolset) => (
              <span key={toolset.id} className="inline-flex h-5 items-center rounded bg-background/80 px-1.5 font-mono text-[11px] leading-none text-muted-foreground ring-1 ring-border/40" title={`${toolset.id}@${toolset.version}`}>
                {toolset.label} · {toolset.toolCount}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-5">
        <h4 className="text-sm font-semibold text-foreground">{t('settings.deployment.connectedExecutors')}</h4>
        <p className="mt-1 text-xs text-muted-foreground">{t('settings.deployment.connectedExecutorsDesc')}</p>
        {executors.length === 0 ? (
          <EmptyRow>{t('settings.deployment.noExecutors')}</EmptyRow>
        ) : (
          <SettingsRecordList testId="settings-connected-executors" className="mt-3">
            {executors.map((executor) => (
              <SettingsRecord key={executor.executorId} title={executor.workspaceName} detail={executor.workspaceId}>
                <SettingsRecordField label={t('settings.deployment.executor')} mono>{executor.executorId}</SettingsRecordField>
                <SettingsRecordField label={t('settings.deployment.executorVersion')} mono>{executor.executorVersion ?? '—'}</SettingsRecordField>
                <SettingsRecordField label={t('settings.deployment.executorProtocol')} mono>{executor.clientVersion ?? '—'}</SettingsRecordField>
                <SettingsRecordField label={t('settings.deployment.runtime')} mono>{executor.runtime} {executor.runtimeVersion}</SettingsRecordField>
                <SettingsRecordField label={t('settings.deployment.features')}>{executorCapabilitiesLabel(executor, t)}</SettingsRecordField>
              </SettingsRecord>
            ))}
          </SettingsRecordList>
        )}
      </div>
    </div>
  )
}

function dashboardDeliveryLabel(build: BuildMetadata | undefined): string {
  if (!build) return 'unknown'
  const files = typeof build.embeddedDashboardFiles === 'number' ? `, ${build.embeddedDashboardFiles} files` : ''
  if (build.dashboardMode === 'embedded') return `embedded in host bundle${files}`
  if (build.dashboardMode === 'static') return 'static dashboard directory'
  if (build.dashboardMode === 'vite') return 'Vite development server'
  return `not bundled (${build.releaseTag})`
}

function hostDeliveryLabel(build: BuildMetadata | undefined): string {
  if (!build) return 'local source checkout'
  if (build.artifactKind === 'cjs') return 'bundle-dashboard-with-runtime.cjs'
  if (build.artifactKind === 'native') return 'native host binary'
  return 'source checkout'
}

function executorDeliveryLabel(build: BuildMetadata): string {
  if (build.artifactKind === 'cjs') return 'agent-kernel-executor.cjs'
  if (build.artifactKind === 'native') return 'native executor binary'
  return 'source checkout'
}

function runtimeLabel(runtime: AttachedExecutor['runtime']): string {
  if (runtime === 'node') return 'Node.js'
  if (runtime === 'browser-webcontainer') return 'Browser WebContainer'
  return runtime
}

function executorInstanceLabel(executor: AttachedExecutor): string {
  const parts: string[] = []
  if (executor.hostname) parts.push(executor.hostname)
  parts.push(`${runtimeLabel(executor.runtime)} ${executor.runtimeVersion}`)
  if (executor.pid !== undefined) parts.push(`pid ${executor.pid}`)
  return parts.join(' | ')
}

function executorHealthLabel(executor: AttachedExecutor, connected: string, legacyMetadataMissing: string): string {
  if (!executor.build) return legacyMetadataMissing
  return connected
}

function executorCapabilitiesLabel(executor: AttachedExecutor, t: ReturnType<typeof useTranslation>['t']): string {
  const features = executor.capabilities?.features
  if (!features) return t('settings.deployment.legacyMetadataMissing')
  const labels = [
    features.backgroundShell ? t('settings.deployment.featureBackgroundShell') : null,
    features.filePicker ? t('settings.deployment.featureFilePicker') : null,
    features.overflowFiles ? t('settings.deployment.featureOverflowFiles') : null,
    features.workspaceSandbox ? t('settings.deployment.featureWorkspaceSandbox') : null,
  ].filter((label): label is string => Boolean(label))
  return labels.length > 0 ? labels.join(', ') : t('settings.deployment.noSpecialFeatures')
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
      <SettingsKeyValueList rows={rows.map(([label, value]) => ({
        label,
        value: <span className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{value}</span>,
      }))} />
      <div className="mt-4 rounded-md bg-muted/40 px-4 py-3 text-xs text-muted-foreground ring-1 ring-border/50">
        <div className="break-words font-mono">HOST_GITHUB_OAUTH_REQUIRED, GITHUB_USERNAME_WHITELIST, EXECUTOR_TOKENS, HOST_AUDIT_DIR</div>
      </div>
    </div>
  )
}

function SocketAdminSection({ payload, onPayloadChange }: { payload: ServerSettingsPayload; onPayloadChange(payload: ServerSettingsPayload): void }): JSX.Element {
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
    if (!Object.prototype.hasOwnProperty.call(editing, invite.id)) return
    const next = editing[invite.id] ?? ''
    setError(null)
    patchInvite.mutate({ id: invite.id, label: next })
  }

  return (
    <div>
      <SectionHeader title={t('settings.sections.executorAccess.label')} subtitle={t('settings.executorAccess.subtitle')} />
      <form onSubmit={submit} className="mb-4 max-w-full min-w-0 overflow-hidden rounded-md bg-muted/30 p-3 ring-1 ring-border/50">
        <div className="grid min-w-0 gap-2 lg:grid-cols-2">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.executorAccess.label')}
            <input
              className="mt-1 h-9 w-full rounded-md border-0 bg-background px-2 text-sm text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('settings.executorAccess.labelPlaceholder')}
              disabled={busy}
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.executorAccess.workspaceId')}
            <input
              className="mt-1 h-9 w-full rounded-md border-0 bg-background px-2 font-mono text-sm text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              placeholder={t('settings.executorAccess.workspacePlaceholder')}
              disabled={busy}
            />
          </label>
        </div>
        <div className="mt-3 flex min-w-0 justify-end">
          <Button type="submit" className="h-9 w-full sm:w-auto" disabled={busy}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.executorAccess.create')}
          </Button>
        </div>
        {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
      </form>
      {plainInvite ? (
        <div className="mb-4 min-w-0 rounded-md bg-primary/5 px-3 py-2 ring-1 ring-primary/30">
          <div className="flex flex-wrap items-center justify-between gap-2">
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
          <div className="mt-1 flex items-start gap-2 rounded bg-background px-2 py-1.5 font-mono text-xs ring-1 ring-border/50">
            <span className="min-w-0 flex-1 break-all" title={inviteCopyValue}>{inviteCopyValue}</span>
            <CopyButton value={inviteCopyValue} />
          </div>
        </div>
      ) : null}
      {invitesQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : invites.length === 0 ? (
        <EmptyRow>{t('settings.executorAccess.empty')}</EmptyRow>
      ) : (
        <div className="space-y-2" data-testid="executor-invite-list">
          {invites.map((invite) => {
            const labelValue = meaningfulInviteLabel(invite.label) ?? ''
            const title = invite.workspaceId ?? (labelValue || t('settings.executorAccess.unboundInvite'))
            const subtitle = invite.workspaceId
              ? labelValue || t('settings.executorAccess.boundInvite')
              : t('settings.executorAccess.waitingForFirstUse')
            return (
              <article key={invite.id} className="rounded-md border border-border bg-card/60 px-3 py-3" data-testid="executor-invite-row">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className={cn('min-w-0 break-words text-sm font-semibold text-foreground [overflow-wrap:anywhere]', invite.workspaceId && 'font-mono')} title={title}>
                          {title}
                        </div>
                        <div className="mt-0.5 min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]" title={subtitle}>
                          {subtitle}
                        </div>
                      </div>
                      <span className={cn('rounded px-1.5 py-0.5 text-xs ring-1', invite.revoked ? 'bg-destructive/10 text-destructive ring-destructive/40' : 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300')}>
                        {invite.revoked ? t('settings.executorAccess.revoked') : t('settings.executorAccess.inviteActive')}
                      </span>
                    </div>
                    <label className="block max-w-md text-[11px] font-medium text-muted-foreground">
                      {t('settings.executorAccess.label')}
                      <input
                        className="mt-1 h-8 w-full rounded-md border-0 bg-background px-2 text-sm text-foreground outline-none ring-1 ring-border/50 focus:ring-ring/50 disabled:opacity-70"
                        value={editing[invite.id] ?? labelValue}
                        onChange={(event) => setEditing((prev) => ({ ...prev, [invite.id]: event.target.value }))}
                        onBlur={() => saveLabel(invite)}
                        placeholder={t('settings.executorAccess.optionalLabelPlaceholder')}
                        aria-label={t('settings.executorAccess.label')}
                        disabled={busy || invite.revoked}
                      />
                    </label>
                    <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                      <InviteMeta label={t('settings.executorAccess.inviteId')} value={invite.id.slice(0, 12)} mono />
                      <InviteMeta label={t('settings.executorAccess.created')} value={formatDate(invite.createdAt)} />
                      <InviteMeta label={t('settings.executorAccess.lastUsed')} value={invite.lastUsedAt ? formatDate(invite.lastUsedAt) : t('settings.executorAccess.never')} />
                    </div>
                  </div>
                  <div className="flex flex-none flex-wrap justify-end gap-1.5">
                    <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => regenerateInvite.mutate(invite.id)} disabled={busy} aria-label={t('settings.executorAccess.regenerate')}>
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {t('settings.executorAccess.regenerate')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="h-8 text-muted-foreground hover:text-destructive" onClick={() => revokeInvite.mutate(invite.id)} disabled={busy || invite.revoked} aria-label={t('settings.executorAccess.revoke')}>
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {t('settings.executorAccess.revoke')}
                    </Button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

function InviteMeta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">{label}</div>
      <div className={cn('mt-0.5 break-words text-foreground [overflow-wrap:anywhere]', mono && 'break-all font-mono')} title={value}>{value}</div>
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
  const [newProviderId, setNewProviderId] = useState('')
  const [newProviderLabel, setNewProviderLabel] = useState('')
  const [newProviderWire, setNewProviderWire] = useState<'openai' | 'anthropic'>('openai')
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('')
  const [newProviderApiKey, setNewProviderApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [label, setLabel] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!payload.providers.some((p) => p.id === providerId)) {
      setProviderId(payload.providers[0]?.id ?? '')
    }
  }, [payload.providers, providerId])

  const addModel = useMutation({
    mutationFn: async (input: { providerId: string; id: string; label?: string; contextWindow?: number }): Promise<ServerSettingsPayload> => {
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
      setContextWindow('')
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const addProvider = useMutation({
    mutationFn: async (input: { id: string; label?: string; wire: 'anthropic' | 'openai'; baseUrl: string; apiKey: string }): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/providers', {
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
      setProviderId(newProviderId.trim())
      setNewProviderId('')
      setNewProviderLabel('')
      setNewProviderBaseUrl('')
      setNewProviderApiKey('')
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const deleteProvider = useMutation({
    mutationFn: async (input: { providerId: string }): Promise<ServerSettingsPayload> => {
      const params = new URLSearchParams({ providerId: input.providerId })
      const res = await fetch(`/settings/providers?${params.toString()}`, { method: 'DELETE' })
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

  const setDefaultModel = useMutation({
    mutationFn: async (input: { model: string }): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings/default-model', {
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
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const busy = addModel.isPending || deleteModel.isPending || addProvider.isPending || deleteProvider.isPending || setDefaultModel.isPending

  const submitProvider = (event: FormEvent): void => {
    event.preventDefault()
    setError(null)
    const trimmedLabel = newProviderLabel.trim()
    addProvider.mutate({
      id: newProviderId.trim(),
      ...(trimmedLabel ? { label: trimmedLabel } : {}),
      wire: newProviderWire,
      baseUrl: newProviderBaseUrl.trim(),
      apiKey: newProviderApiKey,
    })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setError(null)
    const trimmedLabel = label.trim()
    const parsedContextWindow = Number(contextWindow.trim())
    addModel.mutate({
      providerId,
      id: modelId.trim(),
      ...(trimmedLabel ? { label: trimmedLabel } : {}),
      ...(Number.isSafeInteger(parsedContextWindow) && parsedContextWindow > 0 ? { contextWindow: parsedContextWindow } : {}),
    })
  }

  const deleteManual = (deleteProviderId: string, id: string): void => {
    setError(null)
    deleteModel.mutate({ providerId: deleteProviderId, id })
  }

  const deleteManualProvider = (deleteProviderId: string): void => {
    setError(null)
    deleteProvider.mutate({ providerId: deleteProviderId })
  }

  return (
    <div>
      <SectionHeader
        title={t('settings.sections.models.label')}
        subtitle={t('settings.models.subtitle')}
      />
      <form onSubmit={submitProvider} className="mb-4 max-w-full min-w-0 overflow-hidden rounded-md bg-muted/30 p-3 ring-1 ring-border/50">
        <div className="grid min-w-0 gap-3 lg:grid-cols-3">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.providerId')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              value={newProviderId}
              onChange={(event) => setNewProviderId(event.target.value)}
              placeholder="openai-local"
              disabled={busy}
              data-testid="settings-provider-id-input"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.label')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={newProviderLabel}
              onChange={(event) => setNewProviderLabel(event.target.value)}
              placeholder={t('settings.models.optional')}
              disabled={busy}
              data-testid="settings-provider-label-input"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.wire')}
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={newProviderWire}
              onChange={(event) => setNewProviderWire(event.target.value as 'openai' | 'anthropic')}
              disabled={busy}
              data-testid="settings-provider-wire-select"
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic-compatible</option>
            </select>
          </label>
        </div>
        <div className="mt-3 grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.baseUrl')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              value={newProviderBaseUrl}
              onChange={(event) => setNewProviderBaseUrl(event.target.value)}
              placeholder="http://localhost:8000/v1"
              disabled={busy}
              data-testid="settings-provider-base-url-input"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.apiKey')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              type="password"
              value={newProviderApiKey}
              onChange={(event) => setNewProviderApiKey(event.target.value)}
              placeholder="sk-..."
              disabled={busy}
              data-testid="settings-provider-api-key-input"
            />
          </label>
        </div>
        <div className="mt-3 flex min-w-0 justify-end">
          <Button type="submit" className="h-9 w-full sm:w-auto" disabled={busy || newProviderId.trim().length === 0 || newProviderBaseUrl.trim().length === 0 || newProviderApiKey.length === 0}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.models.addProvider')}
          </Button>
        </div>
      </form>
      <form onSubmit={submit} className="mb-4 max-w-full min-w-0 overflow-hidden rounded-md bg-muted/30 p-3 ring-1 ring-border/50">
        <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)]">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
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
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
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
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.contextWindow')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              value={contextWindow}
              onChange={(event) => setContextWindow(event.target.value)}
              placeholder="1000000"
              disabled={payload.providers.length === 0 || busy}
              inputMode="numeric"
              data-testid="settings-model-context-window-input"
            />
          </label>
        </div>
        <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)]">
          <label className="min-w-0 text-xs font-medium text-muted-foreground">
            {t('settings.models.label')}
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t('settings.models.optional')}
              disabled={payload.providers.length === 0 || busy}
            />
          </label>
          <div className="flex min-w-0 justify-end">
            <Button type="submit" className="h-9 w-full sm:w-auto" disabled={payload.providers.length === 0 || busy || modelId.trim().length === 0} data-testid="settings-model-add-button">
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.models.add')}
            </Button>
          </div>
        </div>
        {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
        <div className="mt-2 break-words text-xs text-muted-foreground">
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
              className="max-w-full min-w-0 overflow-hidden rounded-md bg-card/60 p-3 ring-1 ring-border/50 sm:p-4"
              data-testid={`settings-provider-${p.id}`}
            >
              <div className="mb-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                <div className="min-w-0 overflow-hidden">
                  <div className="truncate font-medium" title={p.label}>{p.label}</div>
                  <div className="min-w-0 break-words text-xs text-muted-foreground">
                    <span className="font-mono">{p.wire}</span>
                    {' · '}
                    <SourceBadge source={p.source ?? 'unknown'} />
                    {p.baseUrl ? (
                      <>
                        {' · '}
                        <span className="break-all font-mono">{p.baseUrl}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  {p.models.some((m) => modelKey(m) === payload.defaultModel || m.id === payload.defaultModel) ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground ring-1 ring-primary/40">
                      {t('settings.models.defaultProvider')}
                    </span>
                  ) : null}
                  {p.source === 'manual' ? (
                    <button
                      type="button"
                      onClick={() => { deleteManualProvider(p.id) }}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={t('settings.models.deleteProvider', { provider: p.id })}
                      disabled={busy}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
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
                      className="grid min-w-0 gap-2 rounded bg-muted/40 px-2.5 py-1.5 text-xs ring-1 ring-border/50 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                      <span className="min-w-0 break-all font-mono" title={m.id}>{m.id}</span>
                      <span className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                        <SourceBadge source={m.source ?? p.source ?? 'unknown'} />
                        {m.contextWindow ? (
                          <span className="font-mono text-[10px] text-muted-foreground">{m.contextWindow.toLocaleString()}</span>
                        ) : null}
                        {modelKey(m) === payload.defaultModel || m.id === payload.defaultModel ? (
                          <span className="text-[10px] font-medium uppercase tracking-wide text-primary">
                            {t('settings.models.default')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setError(null)
                              setDefaultModel.mutate({ model: modelKey(m) })
                            }}
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={t('settings.models.setDefaultModel', { model: modelKey(m) })}
                            disabled={busy}
                          >
                            {t('settings.models.setDefault')}
                          </button>
                        )}
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

function modelKey(model: { ref?: string; id: string }): string {
  return model.ref ?? model.id
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
        <SettingsRecordList testId="settings-hooks-list">
          {payload.hooks.map((hook, index) => (
            <SettingsRecord key={`${hook.event}-${index}`} title={hook.event}>
              <SettingsRecordField label={t('settings.hooks.match')} mono>{hook.match ?? '*'}</SettingsRecordField>
              <SettingsRecordField label={t('settings.hooks.command')}>
                <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
                  <span className="min-w-0 flex-1 break-all" title={hook.command}>{hook.command}</span>
                  <CopyButton value={hook.command} />
                </div>
              </SettingsRecordField>
            </SettingsRecord>
          ))}
        </SettingsRecordList>
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

function InterfaceSection({ sessionCache }: { sessionCache?: DurableSessionViewCache }): JSX.Element {
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
  const [chatFontSize, setChatFontSize] = useNumberPref(PREF_CHAT_FONT_SIZE, DEFAULT_CHAT_FONT_SIZE, { min: 0, max: 6 })
  const [sessionExplorerFontSize, setSessionExplorerFontSize] = useNumberPref(PREF_SESSION_EXPLORER_FONT_SIZE, DEFAULT_SESSION_EXPLORER_FONT_SIZE, { min: 0, max: 4 })
  const [fileExplorerFontSize, setFileExplorerFontSize] = useNumberPref(PREF_FILE_EXPLORER_FONT_SIZE, DEFAULT_FILE_EXPLORER_FONT_SIZE, { min: 0, max: 4 })
  const [fileViewFontSize, setFileViewFontSize] = useNumberPref(PREF_FILE_VIEW_FONT_SIZE, DEFAULT_FILE_VIEW_FONT_SIZE, { min: 0, max: 4 })
  const [chatContentWidth, setChatContentWidth] = useNumberPref(PREF_CHAT_CONTENT_WIDTH, DEFAULT_CHAT_CONTENT_WIDTH, { min: 0, max: 2 })
  const [chatSideSpace, setChatSideSpace] = useNumberPref(PREF_CHAT_SIDE_SPACE, DEFAULT_CHAT_SIDE_SPACE, { min: 0, max: 2 })
  const [chatLineHeight, setChatLineHeight] = useNumberPref(PREF_CHAT_LINE_HEIGHT, DEFAULT_CHAT_LINE_HEIGHT, { min: 0, max: 2 })
  const [chatMathScale, setChatMathScale] = useNumberPref(PREF_CHAT_MATH_SCALE, DEFAULT_CHAT_MATH_SCALE, { min: 0, max: 4 })
  const [sessionCacheMaxMb, setSessionCacheMaxMb] = useNumberPref(PREF_SESSION_VIEW_CACHE_MAX_MB, DEFAULT_SESSION_VIEW_CACHE_MAX_MB, { min: 0, max: 4096 })
  const [durableCacheEnabled, setDurableCacheEnabled] = useBooleanPref(PREF_DURABLE_SESSION_CACHE_ENABLED, true)
  const [keepScreenAwake, setKeepScreenAwake] = useBooleanPref(PREF_KEEP_SCREEN_AWAKE, false)
  const [theme, , setTheme, effectiveTheme] = useTheme()
  const [storedVSCodeTheme, setStoredVSCodeTheme] = useState<StoredVSCodeTheme | null>(() => readStoredVSCodeTheme())
  const currentThemeLabel = storedVSCodeTheme?.label ?? builtinThemeForScheme(effectiveTheme).label
  const restoreSavedTheme = (): void => {
    applyCurrentVSCodeTheme(effectiveTheme)
    setStoredVSCodeTheme(readStoredVSCodeTheme())
  }
  const applyStoredTheme = (next: StoredVSCodeTheme | null): void => {
    writeStoredVSCodeTheme(next)
    setStoredVSCodeTheme(next)
  }
  const previewTheme = (next: StoredVSCodeTheme): void => {
    applyVSCodeTheme(next.theme, effectiveTheme)
  }
  useEffect(() => restoreSavedTheme, [effectiveTheme])
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.interface.label')}
        subtitle={t('settings.interface.subtitle')}
      />
      <ul className="space-y-3 text-sm">
        <li className="flex flex-col gap-4 rounded-md bg-card/60 px-4 py-3 ring-1 ring-border/50 sm:flex-row sm:items-start sm:justify-between">
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
        <li className="rounded-md border border-border bg-card/60 px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="font-medium">{t('settings.interface.vscodeTheme.label')}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('settings.interface.vscodeTheme.desc')}
              </p>
              <p className="mt-2 text-xs text-muted-foreground" data-testid="settings-vscode-theme-current">
                {t('settings.interface.vscodeTheme.current', { theme: currentThemeLabel })}
              </p>
            </div>
          </div>
          <MarketplaceThemeBrowser
            activeThemeId={storedVSCodeTheme?.id ?? `agent-kernel-${effectiveTheme}`}
            effectiveTheme={effectiveTheme}
            onPreview={previewTheme}
            onApply={(next) => applyStoredTheme(next)}
          />
        </li>
        <SegmentedNumberPref
          label={t('settings.interface.chatFontSize')}
          description={t('settings.interface.chatFontSizeDesc')}
          value={chatFontSize}
          onChange={setChatFontSize}
          testId="settings-chat-font-size"
          options={[0, 1, 2, 3, 4, 5, 6].map((value) => ({
            value,
            label: t(`settings.interface.chatFontSizeOptions.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.fileViewFontSize')}
          description={t('settings.interface.fileViewFontSizeDesc')}
          value={fileViewFontSize}
          onChange={setFileViewFontSize}
          testId="settings-file-view-font-size"
          options={[0, 1, 2, 3, 4].map((value) => ({
            value,
            label: t(`settings.interface.fileViewFontSizeOptions.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.sessionExplorerFontSize')}
          description={t('settings.interface.sessionExplorerFontSizeDesc')}
          value={sessionExplorerFontSize}
          onChange={setSessionExplorerFontSize}
          testId="settings-session-explorer-font-size"
          options={[0, 1, 2, 3, 4].map((value) => ({
            value,
            label: t(`settings.interface.explorerFontSizeOptions.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.fileExplorerFontSize')}
          description={t('settings.interface.fileExplorerFontSizeDesc')}
          value={fileExplorerFontSize}
          onChange={setFileExplorerFontSize}
          testId="settings-file-explorer-font-size"
          options={[0, 1, 2, 3, 4].map((value) => ({
            value,
            label: t(`settings.interface.explorerFontSizeOptions.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.chatContentWidth')}
          description={t('settings.interface.chatContentWidthDesc')}
          value={chatContentWidth}
          onChange={setChatContentWidth}
          testId="settings-chat-content-width"
          options={[0, 1, 2].map((value) => ({
            value,
            label: t(`settings.interface.size3.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.chatSideSpace')}
          description={t('settings.interface.chatSideSpaceDesc')}
          value={chatSideSpace}
          onChange={setChatSideSpace}
          testId="settings-chat-side-space"
          options={[0, 1, 2].map((value) => ({
            value,
            label: t(`settings.interface.size3.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.chatLineHeight')}
          description={t('settings.interface.chatLineHeightDesc')}
          value={chatLineHeight}
          onChange={setChatLineHeight}
          testId="settings-chat-line-height"
          options={[0, 1, 2].map((value) => ({
            value,
            label: t(`settings.interface.size3.${value}`),
          }))}
        />
        <SegmentedNumberPref
          label={t('settings.interface.chatMathScale')}
          description={t('settings.interface.chatMathScaleDesc')}
          value={chatMathScale}
          onChange={setChatMathScale}
          testId="settings-chat-math-scale"
          options={[0, 1, 2, 3, 4].map((value) => ({
            value,
            label: t(`settings.interface.chatMathScaleOptions.${value}`),
          }))}
        />
        <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
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
        <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
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
        <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="font-medium">{t('settings.interface.sessionCacheMaxMb')}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.interface.sessionCacheMaxMbDesc')}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <input
              type="number"
              min={0}
              max={4096}
              step={50}
              value={sessionCacheMaxMb}
              onChange={(event) => setSessionCacheMaxMb(Number(event.currentTarget.value))}
              className="h-8 w-24 rounded-md bg-background px-2 text-sm ring-1 ring-border/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('settings.interface.sessionCacheMaxMb')}
              data-testid="settings-session-cache-max-mb"
            />
            <span className="text-xs text-muted-foreground">MB</span>
          </div>
        </li>
        <InterfaceToggle
          label="Durable session cache"
          description="Keep recently viewed session content in this browser for fast reloads. The host remains authoritative."
          checked={durableCacheEnabled}
          onChange={setDurableCacheEnabled}
          testId="settings-toggle-durable-session-cache"
        />
        <SessionCacheManagement cache={sessionCache} enabled={durableCacheEnabled} />
        <InterfaceToggle
          label="Keep screen awake while running"
          description={wakeLockSupported() ? 'Prevent screen sleep while the selected session is actively running.' : 'Screen Wake Lock is unavailable in this browser.'}
          checked={keepScreenAwake && wakeLockSupported()}
          onChange={setKeepScreenAwake}
          testId="settings-toggle-keep-screen-awake"
          disabled={!wakeLockSupported()}
        />
      </ul>
    </div>
  )
}

type MarketplaceSearchResult = {
  namespace: string
  name: string
  displayName: string
  description: string
  version: string
  verified: boolean
  downloadCount: number
  iconUrl?: string
}

type MarketplaceExtension = MarketplaceSearchResult & {
  themes: Array<{ id: string; label: string; uiTheme: string; path: string }>
}

function MarketplaceThemeBrowser({
  activeThemeId,
  effectiveTheme,
  onPreview,
  onApply,
}: {
  activeThemeId: string
  effectiveTheme: 'dark' | 'light'
  onPreview(theme: StoredVSCodeTheme): void
  onApply(theme: StoredVSCodeTheme): void
}): JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('dark')
  const [selected, setSelected] = useState<MarketplaceSearchResult | null>(null)
  const [previewThemeId, setPreviewThemeId] = useState<string | null>(null)
  const [themeAction, setThemeAction] = useState<{ id: string; kind: 'preview' | 'apply' } | null>(null)
  const searchQuery = useQuery({
    queryKey: ['vscode-theme-marketplace-search', query],
    queryFn: async (): Promise<MarketplaceSearchResult[]> => {
      const res = await fetch(`/themes/marketplace/search?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(await responseError(res))
      const payload = await res.json() as { results?: MarketplaceSearchResult[] }
      return payload.results ?? []
    },
    enabled: query.trim().length > 0,
    staleTime: 60_000,
  })
  const extensionQuery = useQuery({
    queryKey: ['vscode-theme-marketplace-extension', selected?.namespace, selected?.name],
    queryFn: async (): Promise<MarketplaceExtension> => {
      if (!selected) throw new Error('missing extension')
      const res = await fetch(`/themes/marketplace/extensions/${encodeURIComponent(selected.namespace)}/${encodeURIComponent(selected.name)}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(await responseError(res))
      return await res.json() as MarketplaceExtension
    },
    enabled: selected !== null,
    staleTime: 60_000,
  })

  const loadTheme = async (extension: MarketplaceExtension, themeId: string): Promise<StoredVSCodeTheme> => {
    const res = await fetch(`/themes/marketplace/extensions/${encodeURIComponent(extension.namespace)}/${encodeURIComponent(extension.name)}/themes/${encodeURIComponent(themeId)}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(await responseError(res))
    const payload = await res.json() as { theme: unknown; extension: MarketplaceExtension }
    const theme = validateVSCodeTheme(payload.theme)
    if (!theme) throw new Error(t('settings.interface.vscodeTheme.invalidTheme'))
    const contribution = extension.themes.find((entry) => entry.id === themeId || entry.label === themeId)
    return {
      source: 'marketplace',
      id: `${extension.namespace}.${extension.name}:${themeId}`,
      label: contribution?.label ?? theme.name ?? themeId,
      extension: `${extension.namespace}.${extension.name}`,
      theme: { ...theme, name: theme.name ?? contribution?.label },
    }
  }

  const selectedThemes = extensionQuery.data?.themes ?? []
  const themeRows: Array<{
    id: string
    label: string
    source: string
    load(): Promise<StoredVSCodeTheme> | StoredVSCodeTheme
  }> = [
    ...BUILTIN_VSCODE_THEMES.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      source: `${candidate.label} / ${candidate.theme.type === 'light' ? 'vs' : 'vs-dark'}`,
      load: () => candidate,
    })),
    ...selectedThemes.map((candidate) => ({
      id: `${extensionQuery.data!.namespace}.${extensionQuery.data!.name}:${candidate.id}`,
      label: candidate.label,
      source: `${extensionQuery.data!.displayName} / ${candidate.uiTheme}`,
      load: () => loadTheme(extensionQuery.data!, candidate.id),
    })),
  ]

  const runThemeAction = async (row: (typeof themeRows)[number], kind: 'preview' | 'apply'): Promise<void> => {
    setThemeAction({ id: row.id, kind })
    try {
      const theme = await Promise.resolve(row.load())
      if (kind === 'preview') {
        onPreview(theme)
        setPreviewThemeId(row.id)
      } else {
        onApply(theme)
        setPreviewThemeId(null)
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setThemeAction((current) => current?.id === row.id && current.kind === kind ? null : current)
    }
  }

  return (
    <div className="mt-4 space-y-3" data-testid="settings-vscode-marketplace">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-sm font-medium">{t('settings.interface.vscodeTheme.themeList')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.interface.vscodeTheme.marketplaceDesc')}</p>
        </div>
        <div className="flex min-w-0 gap-2">
          <input
            className="h-8 min-w-0 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('settings.interface.vscodeTheme.searchPlaceholder')}
            data-testid="settings-vscode-marketplace-search"
          />
          <Button type="button" variant="outline" size="sm" onClick={() => searchQuery.refetch()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('settings.interface.vscodeTheme.refresh')}
          </Button>
        </div>
      </div>
      {searchQuery.error ? <div className="text-xs text-destructive">{(searchQuery.error as Error).message}</div> : null}
      <div className="rounded-md border border-border bg-background/40 p-2">
        <div className="mb-2 flex items-center justify-between gap-2 text-xs">
          <div className="font-medium text-muted-foreground">{t('settings.interface.vscodeTheme.searchResults')}</div>
          {selected ? <div className="min-w-0 truncate text-[11px] text-muted-foreground">{selected.displayName}</div> : null}
        </div>
        <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
          {(searchQuery.data ?? []).map((result) => (
            <button
              key={`${result.namespace}.${result.name}`}
              type="button"
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground', selected?.namespace === result.namespace && selected.name === result.name ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}
              onClick={() => setSelected(result)}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-foreground">{result.displayName}</div>
                <div className="truncate text-[11px]">{result.namespace}.{result.name}</div>
              </div>
              {result.verified ? <span className="rounded border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary">{t('settings.interface.vscodeTheme.verified')}</span> : null}
            </button>
          ))}
          {searchQuery.isLoading ? <div className="px-2 py-1 text-xs text-muted-foreground">{t('common.loading')}</div> : null}
          {selected !== null && extensionQuery.isLoading ? <div className="px-2 py-1 text-xs text-muted-foreground">{t('settings.interface.vscodeTheme.loadingThemes')}</div> : null}
          {extensionQuery.error ? <div className="px-2 py-1 text-xs text-destructive">{(extensionQuery.error as Error).message}</div> : null}
        </div>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background/60" data-testid="settings-vscode-theme-list">
        <div className="max-h-72 divide-y divide-border overflow-y-auto">
          {themeRows.map((row) => {
            const active = activeThemeId === row.id || (!activeThemeId && row.id === `agent-kernel-${effectiveTheme}`)
            return (
              <ThemeListRow
                key={row.id}
                id={row.id}
                label={row.label}
                source={row.source}
                active={active}
                previewing={previewThemeId === row.id}
                previewLoading={themeAction?.id === row.id && themeAction.kind === 'preview'}
                applyLoading={themeAction?.id === row.id && themeAction.kind === 'apply'}
                onPreview={() => void runThemeAction(row, 'preview')}
                onApply={() => void runThemeAction(row, 'apply')}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ThemeListRow({
  id,
  label,
  source,
  active,
  previewing,
  previewLoading,
  applyLoading,
  onPreview,
  onApply,
}: {
  id: string
  label: string
  source: string
  active: boolean
  previewing: boolean
  previewLoading: boolean
  applyLoading: boolean
  onPreview(): void
  onApply(): void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center" data-testid={`settings-vscode-theme-${id}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-medium">{label}</div>
            {active ? <span className="flex-none rounded border border-primary/40 px-1.5 py-0.5 text-[10px] text-primary">{t('settings.interface.vscodeTheme.active')}</span> : null}
            {previewing ? <span className="flex-none rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground">{t('settings.interface.vscodeTheme.previewing')}</span> : null}
          </div>
          <div className="truncate text-xs text-muted-foreground">{source}</div>
        </div>
      </div>
      <div className="flex flex-none gap-2 sm:justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onPreview} disabled={previewLoading || applyLoading}>
          {previewLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Eye className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          {t('settings.interface.vscodeTheme.preview')}
        </Button>
        <Button type="button" size="sm" onClick={onApply} disabled={active || previewLoading || applyLoading}>
          {applyLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          {t('settings.interface.vscodeTheme.apply')}
        </Button>
      </div>
    </div>
  )
}

function SegmentedNumberPref({
  label,
  description,
  value,
  onChange,
  options,
  testId,
}: {
  label: string
  description: string
  value: number
  onChange(next: number): void
  options: readonly { value: number; label: string }[]
  testId: string
}): JSX.Element {
  return (
    <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex max-w-full flex-wrap gap-1 rounded-md border border-border bg-background/70 p-1"
        data-testid={testId}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            data-testid={`${testId}-${option.value}`}
            className={cn(
              'min-h-8 rounded px-2.5 py-1 text-xs transition-colors',
              value === option.value
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </li>
  )
}

function NotificationsSection(): JSX.Element {
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

function SessionCacheManagement({ cache, enabled }: { cache?: DurableSessionViewCache; enabled: boolean }): JSX.Element {
  const [stats, setStats] = useState<{ sessions: number; estimatedBytes: number; maxBytes: number } | null>(null)
  const [persistent, setPersistent] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    setStats(cache ? await cache.durableStats().catch(() => null) : null)
    setPersistent(await navigator.storage?.persisted?.().catch(() => false) ?? null)
  }
  useEffect(() => { void refresh() }, [cache, enabled])

  const clear = async (): Promise<void> => {
    if (!cache) return
    setBusy(true)
    await cache.clearDurable()
    await refresh()
    setBusy(false)
  }
  const requestPersistence = async (): Promise<void> => {
    if (!navigator.storage?.persist) return
    setBusy(true)
    setPersistent(await navigator.storage.persist().catch(() => false))
    setBusy(false)
  }

  return (
    <li className="rounded-md border border-border/50 bg-card/60 px-4 py-3" data-testid="settings-session-cache-management">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs text-muted-foreground">
          <div>{enabled ? `${stats?.sessions ?? 0} cached sessions - ${formatBytes(stats?.estimatedBytes ?? 0)}` : 'Durable cache disabled'}</div>
          <div className="mt-0.5">Browser storage: {persistent === null ? 'unknown' : persistent ? 'persistent' : 'evictable'}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy || !navigator.storage?.persist} onClick={() => void requestPersistence()}>Keep cache</Button>
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy || !cache} onClick={() => void clear()}>Clear cache</Button>
        </div>
      </div>
    </li>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function InterfaceToggle({
  label,
  description,
  checked,
  onChange,
  testId,
  disabled = false,
}: {
  label: string
  description: string
  checked: boolean
  onChange(next: boolean): void
  testId: string
  disabled?: boolean
}): JSX.Element {
  return (
    <li className="flex flex-col gap-4 rounded-md border border-border bg-card/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} ariaLabel={label} testId={testId} disabled={disabled} />
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

/**
 * Web Push (background) subscription toggle. Sits below the foreground
 * desktop-notification prefs and reuses the same per-kind toggles so the
 * server dispatches the same categories the user already opted in to.
 *
 * Kept separate from DesktopNotificationsSettings because feature detection,
 * subscription state, and iOS-standalone gating are all specific to Push
 * and would clutter the foreground path.
 */
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
    <div className="rounded-md border border-dashed border-white/15 bg-black/20 px-4 py-6 text-sm text-zinc-400">
      {children}
    </div>
  )
}

function SettingsKeyValueList({
  rows,
  testId,
}: {
  rows: readonly { label: string; value: React.ReactNode }[]
  testId?: string
}): JSX.Element {
  return (
    <dl className="overflow-hidden rounded-md ring-1 ring-border/50" data-testid={testId}>
      {rows.map((row, index) => (
        <div
          key={row.label}
          className={cn(
            'grid min-w-0 gap-1.5 px-3 py-2.5 sm:grid-cols-[minmax(8rem,0.42fr)_minmax(0,1fr)] sm:items-center sm:gap-4',
            index !== rows.length - 1 && 'border-b border-border/50',
          )}
        >
          <dt className="text-xs font-medium text-muted-foreground sm:text-sm sm:text-foreground">{row.label}</dt>
          <dd className="min-w-0 text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function SettingsRecordList({
  children,
  testId,
  className,
}: {
  children: React.ReactNode
  testId?: string
  className?: string
}): JSX.Element {
  return (
    <div className={cn('grid min-w-0 gap-2', className)} data-testid={testId}>
      {children}
    </div>
  )
}

function SettingsRecord({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="min-w-0 rounded-md bg-muted/20 p-3 ring-1 ring-border/50">
      <div className="min-w-0 border-b border-border/40 pb-2">
        <div className="break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">{title}</div>
        {detail ? <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{detail}</div> : null}
      </div>
      <dl className="mt-2 grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-2">{children}</dl>
    </div>
  )
}

function SettingsRecordField({
  label,
  mono = false,
  children,
}: {
  label: string
  mono?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(6rem,0.42fr)_minmax(0,1fr)] items-baseline gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words text-foreground [overflow-wrap:anywhere]', mono && 'font-mono')}>{children}</dd>
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
      className="h-6 w-6 flex-none text-zinc-400 hover:bg-white/10 hover:text-zinc-50"
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

      <div className="space-y-3 rounded-md bg-card/60 p-4 text-sm ring-1 ring-border/50">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Currently used</div>
          <div className="mt-1 break-all font-mono">{current.url || '(none)'}</div>
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
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={window.location.origin}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="text-xs text-muted-foreground">
          Leave empty to fall back to the default. Cross-origin endpoints require the host to set
          {' '}<code className="rounded bg-muted px-1">AGENT_KERNEL_ALLOWED_ORIGINS</code>.
        </div>
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <Button size="sm" className="w-full sm:w-auto" onClick={save}>Save</Button>
          <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => void test()} disabled={testState.kind === 'testing'}>
            {testState.kind === 'testing' ? 'Testing…' : 'Test connection'}
          </Button>
          <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={reset}>Reset to default</Button>
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
