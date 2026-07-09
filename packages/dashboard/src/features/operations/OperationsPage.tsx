import { useTranslation } from 'react-i18next'

import { OpsView } from '../artifacts/OpsView.js'
import { ProfilesView } from '../artifacts/ProfilesView.js'

export function OperationsPage(_: {
  onOpenSession?(sessionId: string): void
} = {}): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="operations-page">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur">
        <h1 className="text-sm font-semibold" data-testid="operations-page-title">
          {t('operations.pageTitle')}
        </h1>
        <p className="text-xs text-muted-foreground">{t('operations.pageSubtitle')}</p>
      </header>
      <div className="flex-1 min-h-0 overflow-auto">
        <section className="min-h-[420px]" data-testid="operations-ops-panel">
          <div className="border-b border-border/60 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('operations.opsTitle')}
            </h2>
            <p className="text-[11px] text-muted-foreground">{t('operations.opsSubtitle')}</p>
          </div>
          <OpsView />
        </section>
        <section className="border-t border-border/60 min-h-[420px]" data-testid="operations-profiles-panel">
          <div className="border-b border-border/60 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('operations.profilesTitle')}
            </h2>
            <p className="text-[11px] text-muted-foreground">{t('operations.profilesSubtitle')}</p>
          </div>
          <ProfilesView />
        </section>
      </div>
    </div>
  )
}
