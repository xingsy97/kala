import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ProductPage, ProductPageBody, ProductPageHeader, ProductPanel, ProductPanelHeader, ProductSegment, ProductSegmentedControl } from '../../components/ui/product-page.js'
import { OpsView } from '../artifacts/OpsView.js'
import { ProfilesView } from '../artifacts/ProfilesView.js'

type OperationsSection = 'ops' | 'profiles'

export function OperationsPage({ onOpenSession }: {
  onOpenSession?(sessionId: string): void
} = {}): JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<OperationsSection>('ops')

  return (
    <ProductPage testId="operations-page">
      <ProductPageHeader title={t('operations.pageTitle')} description={t('operations.pageSubtitle')} titleTestId="operations-page-title" actions={
        <ProductSegmentedControl label={t('operations.pageTitle')}>
          <ProductSegment active={section === 'ops'} onClick={() => setSection('ops')} testId="operations-mobile-ops">{t('operations.opsTitle')}</ProductSegment>
          <ProductSegment active={section === 'profiles'} onClick={() => setSection('profiles')} testId="operations-mobile-profiles">{t('operations.profilesTitle')}</ProductSegment>
        </ProductSegmentedControl>
      } />
      <ProductPageBody>
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
