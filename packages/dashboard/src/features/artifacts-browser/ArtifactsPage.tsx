import { useTranslation } from 'react-i18next'

import { ArtifactInventoryView } from '../artifacts/ArtifactInventoryView.js'
import { MemoryView } from '../artifacts/MemoryView.js'

export function ArtifactsPage(_: {
  onOpenSession?(sessionId: string): void
} = {}): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="artifacts-page">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur">
        <h1 className="text-sm font-semibold" data-testid="artifacts-page-title">
          {t('artifactsPage.pageTitle')}
        </h1>
        <p className="text-xs text-muted-foreground">{t('artifactsPage.pageSubtitle')}</p>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">
        <section className="min-h-[420px]" data-testid="artifacts-main-panel">
          <div className="border-b border-border/60 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('artifactsPage.artifactsTitle')}
            </h2>
          </div>
          <ArtifactInventoryView />
        </section>
        <section className="border-t border-border/60 min-h-[420px]" data-testid="artifacts-memory-panel">
          <div className="border-b border-border/60 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('artifactsPage.memoryTitle')}
            </h2>
            <p className="text-[11px] text-muted-foreground">{t('artifactsPage.memorySubtitle')}</p>
          </div>
          <MemoryView />
        </section>
      </div>
    </div>
  )
}
