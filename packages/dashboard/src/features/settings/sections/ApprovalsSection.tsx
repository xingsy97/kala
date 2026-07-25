import { useTranslation } from 'react-i18next'

import { SectionHeader } from '../controls.js'

export function ApprovalsSection(): JSX.Element {
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
