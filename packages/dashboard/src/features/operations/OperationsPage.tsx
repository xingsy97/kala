import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Boxes, RadioTower, Route, ShieldCheck } from 'lucide-react'
import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

import { ProductPage, ProductPageBody, ProductPageHeader, ProductPanel, ProductPanelHeader, ProductSegment, ProductSegmentedControl } from '../../components/ui/product-page.js'
import type { SessionActivityStatus } from '../explorer/Explorer.js'
import { isRunningSessionActivity } from '../../app-logic/session-activity.js'
import type { RuntimeDeploymentState } from '../../runtime-capabilities.js'
import { OpsView } from '../artifacts/OpsView.js'
import { ProfilesView } from '../artifacts/ProfilesView.js'

type OperationsSection = 'ops' | 'profiles'

export function OperationsPage({ deployment, executors = [], sessions = [], sessionStatuses, onOpenSession }: {
  deployment?: RuntimeDeploymentState
  executors?: readonly AttachedExecutor[]
  sessions?: readonly SessionSummary[]
  sessionStatuses?: ReadonlyMap<string, SessionActivityStatus>
  onOpenSession?(sessionId: string): void
} = {}): JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<OperationsSection>('ops')
  const running = sessions.filter((session) => isRunningSessionActivity(sessionStatuses?.get(session.sessionId) ?? session.status)).length
  const waiting = sessions.filter((session) => (sessionStatuses?.get(session.sessionId) ?? session.status) === 'awaiting_approval').length
  const queued = sessions.reduce((sum, session) => sum + (session.queuedCount ?? 0), 0)
  const enabledCapabilities = deployment
    ? Object.entries(deployment.capabilities).filter(([, enabled]) => enabled).map(([key]) => key)
    : []

  return (
    <ProductPage testId="operations-page">
      <ProductPageHeader title={t('operations.pageTitle')} description={t('operations.pageSubtitle')} titleTestId="operations-page-title" actions={
        <ProductSegmentedControl label={t('operations.pageTitle')}>
          <ProductSegment active={section === 'ops'} onClick={() => setSection('ops')} testId="operations-mobile-ops">{t('operations.opsTitle')}</ProductSegment>
          <ProductSegment active={section === 'profiles'} onClick={() => setSection('profiles')} testId="operations-mobile-profiles">{t('operations.profilesTitle')}</ProductSegment>
        </ProductSegmentedControl>
      } />
      <ProductPageBody>
        <RuntimeOperationsDashboard
          product={deployment?.product}
          deploymentMode={deployment?.deployment ? deployment.deployment.architecture === 'platform' ? deployment.deployment.tenancy : deployment.deployment.architecture : undefined}
          capabilities={enabledCapabilities}
          executorCount={executors.length}
          sessionCount={sessions.length}
          running={running}
          waiting={waiting}
          queued={queued}
        />
        <ProductPanel active={section === 'ops'} testId="operations-ops-panel">
          <ProductPanelHeader title={t('operations.opsTitle')} description={t('operations.opsSubtitle')} />
          <OpsView onOpenSession={onOpenSession} />
        </ProductPanel>
        <ProductPanel active={section === 'profiles'} testId="operations-profiles-panel">
          <ProductPanelHeader title={t('operations.profilesTitle')} description={t('operations.profilesSubtitle')} />
          <ProfilesView onOpenSession={onOpenSession} />
        </ProductPanel>
      </ProductPageBody>
    </ProductPage>
  )
}

function RuntimeOperationsDashboard({ product, deploymentMode, capabilities, executorCount, sessionCount, running, waiting, queued }: {
  product?: string | null
  deploymentMode?: string
  capabilities: string[]
  executorCount: number
  sessionCount: number
  running: number
  waiting: number
  queued: number
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" data-testid="runtime-operations-dashboard">
      <OpsMetric icon={RadioTower} label={t('operations.dashboard.runtime')} value={product ?? 'local'} detail={deploymentMode ?? t('operations.dashboard.loaded')} tone="info" />
      <OpsMetric icon={Boxes} label={t('operations.dashboard.executors')} value={String(executorCount)} detail={t('operations.dashboard.sessions', { count: sessionCount })} tone={executorCount ? 'good' : 'neutral'} />
      <OpsMetric icon={Activity} label={t('operations.dashboard.activeWork')} value={String(running)} detail={t('operations.dashboard.queued', { count: queued })} tone={running || queued ? 'info' : 'neutral'} />
      <OpsMetric icon={ShieldCheck} label={t('operations.dashboard.attention')} value={String(waiting)} detail={capabilities.join(' · ') || t('operations.dashboard.noCapabilities')} tone={waiting ? 'warn' : 'good'} />
    </section>
  )
}

function OpsMetric({ icon: Icon, label, value, detail, tone }: { icon: typeof Route; label: string; value: string; detail: string; tone: 'neutral' | 'good' | 'warn' | 'info' }): JSX.Element {
  return (
    <div className="ak-workspace-surface relative overflow-hidden p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
        <Icon className={tone === 'good' ? 'h-4 w-4 text-emerald-500' : tone === 'warn' ? 'h-4 w-4 text-amber-500' : tone === 'info' ? 'h-4 w-4 text-sky-500' : 'h-4 w-4 text-muted-foreground'} aria-hidden />
      </div>
      <div className="mt-3 truncate font-mono text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}
