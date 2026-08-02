import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '../../lib/utils.js'
import { OpsView } from '../artifacts/OpsView.js'
import { ProfilesView } from '../artifacts/ProfilesView.js'

type OperationsSection = 'ops' | 'profiles'

export function OperationsPage(_: {
  onOpenSession?(sessionId: string): void
} = {}): JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<OperationsSection>('ops')

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="operations-page">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur">
        <h1 className="text-sm font-semibold" data-testid="operations-page-title">{t('operations.pageTitle')}</h1>
        <p className="text-xs text-muted-foreground">{t('operations.pageSubtitle')}</p>
        <div className="mt-2 grid grid-cols-2 rounded-lg bg-muted p-1 md:hidden" role="group" aria-label={t('operations.pageTitle')}>
          <SectionButton active={section === 'ops'} onClick={() => setSection('ops')} testId="operations-mobile-ops">{t('operations.opsTitle')}</SectionButton>
          <SectionButton active={section === 'profiles'} onClick={() => setSection('profiles')} testId="operations-mobile-profiles">{t('operations.profilesTitle')}</SectionButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto md:grid md:grid-rows-2">
        <section className={cn('min-h-0', section !== 'ops' && 'hidden md:block')} data-testid="operations-ops-panel">
          <SectionHeader title={t('operations.opsTitle')} subtitle={t('operations.opsSubtitle')} />
          <OpsView />
        </section>
        <section className={cn('min-h-0 border-t border-border/60', section !== 'profiles' && 'hidden md:block')} data-testid="operations-profiles-panel">
          <SectionHeader title={t('operations.profilesTitle')} subtitle={t('operations.profilesSubtitle')} />
          <ProfilesView />
        </section>
      </div>
    </div>
  )
}

function SectionButton({ active, onClick, testId, children }: { active: boolean; onClick(): void; testId: string; children: React.ReactNode }): JSX.Element {
  return <button type="button" aria-pressed={active} onClick={onClick} data-testid={testId} className={cn('h-10 rounded-md px-3 text-sm', active ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>{children}</button>
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }): JSX.Element {
  return <div className="border-b border-border/60 px-4 py-2"><h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2><p className="text-[11px] text-muted-foreground">{subtitle}</p></div>
}
