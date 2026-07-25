import type { AttachedExecutor, BuildMetadata, ServerSettingsPayload } from '@agent-kernel/shared'
import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { useTranslation } from 'react-i18next'

import { EmptyRow, SectionHeader, SettingsRecord, SettingsRecordField, SettingsRecordList } from '../controls.js'
import { executorSetupCommand } from '../section-utils.js'
import packageJson from '../../../../package.json'

const DASHBOARD_VERSION = packageJson.version

export function DeploymentSection({
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
