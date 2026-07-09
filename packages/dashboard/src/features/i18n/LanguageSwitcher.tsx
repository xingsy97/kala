import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
import { i18n, type DashboardLanguage } from '../../i18n/index.js'

export function LanguageSwitcher(): JSX.Element {
  const { t } = useTranslation()
  const language: DashboardLanguage = i18n.resolvedLanguage === 'zh' ? 'zh' : 'en'
  const next: DashboardLanguage = language === 'en' ? 'zh' : 'en'
  const label = language === 'en' ? 'EN' : 'ZH'

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void i18n.changeLanguage(next)}
      title={t('language.switcherLabel')}
      aria-label={t('language.switcherLabel')}
      data-testid="language-switcher"
      className="h-8 gap-1.5 px-2 text-xs"
    >
      <Languages className="h-4 w-4 flex-none" aria-hidden="true" />
      <span>{label}</span>
    </Button>
  )
}

