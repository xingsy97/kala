import { Maximize2, Minimize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { cn } from '../../../lib/utils.js'
import type { ComposerMode } from './useComposerMode.js'

type Props = {
  mode: ComposerMode
  onToggle(): void
  className?: string
}

export function ComposerModeToggle({ mode, onToggle, className }: Props): JSX.Element {
  const { t } = useTranslation()
  const isSimple = mode === 'simple'
  const label = isSimple ? t('composer.mode.toFull') : t('composer.mode.toSimple')
  const Icon = isSimple ? Maximize2 : Minimize2
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={isSimple}
      title={label}
      data-testid="composer-mode-toggle"
      className={cn('h-8 w-8 text-muted-foreground hover:text-foreground sm:h-6 sm:w-6', className)}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </Button>
  )
}
