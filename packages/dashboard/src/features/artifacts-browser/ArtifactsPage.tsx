import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '../../lib/utils.js'
import { ArtifactInventoryView } from '../artifacts/ArtifactInventoryView.js'
import { MemoryView } from '../artifacts/MemoryView.js'

type ArtifactSection = 'artifacts' | 'memory'

export function ArtifactsPage({ onOpenSession }: {
  onOpenSession?(sessionId: string): void
} = {}): JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<ArtifactSection>('artifacts')

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="artifacts-page">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur">
        <h1 className="text-sm font-semibold" data-testid="artifacts-page-title">{t('artifactsPage.pageTitle')}</h1>
        <p className="text-xs text-muted-foreground">{t('artifactsPage.pageSubtitle')}</p>
        <div className="mt-2 grid grid-cols-2 rounded-lg bg-muted p-1 md:hidden" role="group" aria-label={t('artifactsPage.pageTitle')}>
          <SectionButton active={section === 'artifacts'} onClick={() => setSection('artifacts')} testId="artifacts-mobile-inventory">{t('artifactsPage.artifactsTitle')}</SectionButton>
          <SectionButton active={section === 'memory'} onClick={() => setSection('memory')} testId="artifacts-mobile-memory">{t('artifactsPage.memoryTitle')}</SectionButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto md:grid md:grid-rows-2">
        <section className={cn('min-h-0', section !== 'artifacts' && 'hidden md:block')} data-testid="artifacts-main-panel">
          <div className="border-b border-border/60 px-4 py-2"><h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('artifactsPage.artifactsTitle')}</h2></div>
          <ArtifactInventoryView onOpenSession={onOpenSession} />
        </section>
        <section className={cn('min-h-0 border-t border-border/60', section !== 'memory' && 'hidden md:block')} data-testid="artifacts-memory-panel">
          <div className="border-b border-border/60 px-4 py-2"><h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('artifactsPage.memoryTitle')}</h2><p className="text-[11px] text-muted-foreground">{t('artifactsPage.memorySubtitle')}</p></div>
          <MemoryView onOpenSession={onOpenSession} />
        </section>
      </div>
    </div>
  )
}

function SectionButton({ active, onClick, testId, children }: { active: boolean; onClick(): void; testId: string; children: React.ReactNode }): JSX.Element {
  return <button type="button" aria-pressed={active} onClick={onClick} data-testid={testId} className={cn('h-10 rounded-md px-3 text-sm', active ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}>{children}</button>
}
