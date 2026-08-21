import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ProductPage, ProductPageBody, ProductPageHeader, ProductPanel, ProductPanelHeader, ProductSegment, ProductSegmentedControl } from '../../components/ui/product-page.js'
import { ArtifactInventoryView } from '../artifacts/ArtifactInventoryView.js'
import { MemoryView } from '../artifacts/MemoryView.js'

type ArtifactSection = 'artifacts' | 'memory'

export function ArtifactsPage({ onOpenSession }: {
  onOpenSession?(sessionId: string): void
} = {}): JSX.Element {
  const { t } = useTranslation()
  const [section, setSection] = useState<ArtifactSection>('artifacts')

  return (
    <ProductPage testId="artifacts-page">
      <ProductPageHeader title={t('artifactsPage.pageTitle')} description={t('artifactsPage.pageSubtitle')} titleTestId="artifacts-page-title" actions={
        <ProductSegmentedControl label={t('artifactsPage.pageTitle')}>
          <ProductSegment active={section === 'artifacts'} onClick={() => setSection('artifacts')} testId="artifacts-mobile-inventory">{t('artifactsPage.artifactsTitle')}</ProductSegment>
          <ProductSegment active={section === 'memory'} onClick={() => setSection('memory')} testId="artifacts-mobile-memory">{t('artifactsPage.memoryTitle')}</ProductSegment>
        </ProductSegmentedControl>
      } />
      <ProductPageBody>
        <ProductPanel active={section === 'artifacts'} testId="artifacts-main-panel">
          <ProductPanelHeader title={t('artifactsPage.artifactsTitle')} />
          <ArtifactInventoryView onOpenSession={onOpenSession} />
        </ProductPanel>
        <ProductPanel active={section === 'memory'} testId="artifacts-memory-panel">
          <ProductPanelHeader title={t('artifactsPage.memoryTitle')} description={t('artifactsPage.memorySubtitle')} />
          <MemoryView onOpenSession={onOpenSession} />
        </ProductPanel>
      </ProductPageBody>
    </ProductPage>
  )
}
