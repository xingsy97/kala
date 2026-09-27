import { Maximize2, Minimize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from './button.js'
import { cn } from '../../lib/utils.js'

type Props = {
  expanded: boolean
  onToggle(): void
  className?: string
  testId: string
}

export function ModalSizeToggle({ expanded, onToggle, className, testId }: Props): JSX.Element {
  const { t } = useTranslation()
  const label = expanded ? t('common.exitFullscreen') : t('common.enterFullscreen')
  const Icon = expanded ? Minimize2 : Maximize2
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('h-9 w-9 flex-none rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground', className)}
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={expanded}
      data-testid={testId}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </Button>
  )
}
