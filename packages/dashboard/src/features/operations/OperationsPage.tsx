import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '../../lib/utils.js'
import { OpsView } from '../artifacts/OpsView.js'
import { ProfilesView } from '../artifacts/ProfilesView.js'

type OperationsSection = 'ops' | 'profiles'

export function OperationsPage({ onOpenSession }: {
  onOpenSession?(sessionId: string): void
} = {}): JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<OperationsSection>('ops')

  return (
    <div className="ak-workspace-canvas flex h-full min-h-0 flex-col overflow-auto" data-testid="operations-page">
      <header className="mx-auto flex w-full max-w-[96rem] flex-none flex-col gap-4 px-4 pb-4 pt-6 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary/80">Agent RunLab</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.025em]" data-testid="operations-page-title">{t('operations.pageTitle')}</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{t('operations.pageSubtitle')}</p>
        </div>
        <div className="ak-segmented-control grid w-full grid-cols-2 sm:w-auto sm:min-w-80" role="group" aria-label={t('operations.pageTitle')}>
          <SectionButton active={section === 'ops'} onClick={() => setSection('ops')} testId="operations-mobile-ops">{t('operations.opsTitle')}</SectionButton>
          <SectionButton active={section === 'profiles'} onClick={() => setSection('profiles')} testId="operations-mobile-profiles">{t('operations.profilesTitle')}</SectionButton>
        </div>
      </header>
      <div className="mx-auto min-h-[32rem] w-full max-w-[96rem] flex-1 px-3 pb-6 sm:px-6 lg:px-8">
        <section className={cn('ak-workspace-surface flex h-full min-h-0 flex-col overflow-hidden', section !== 'ops' && 'hidden')} data-testid="operations-ops-panel">
          <SectionHeader title={t('operations.opsTitle')} subtitle={t('operations.opsSubtitle')} />
          <OpsView onOpenSession={onOpenSession} />
        </section>
        <section className={cn('ak-workspace-surface flex h-full min-h-0 flex-col overflow-hidden', section !== 'profiles' && 'hidden')} data-testid="operations-profiles-panel">
          <SectionHeader title={t('operations.profilesTitle')} subtitle={t('operations.profilesSubtitle')} />
          <ProfilesView onOpenSession={onOpenSession} />
        </section>
      </div>
    </div>
  )
}

function SectionButton({ active, onClick, testId, children }: { active: boolean; onClick(): void; testId: string; children: React.ReactNode }): JSX.Element {
  return <button type="button" aria-pressed={active} onClick={onClick} data-testid={testId} className={cn('h-10 rounded-lg px-4 text-sm font-medium transition-all', active ? 'bg-card text-foreground shadow-sm ring-1 ring-border/40' : 'text-muted-foreground hover:bg-card/50 hover:text-foreground')}>{children}</button>
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }): JSX.Element {
  return <div className="flex-none border-b border-border/35 px-5 py-4 sm:px-6"><h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{subtitle}</p></div>
}
