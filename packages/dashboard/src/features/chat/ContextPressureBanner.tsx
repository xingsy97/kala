import { AlertTriangle, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AgentState } from '@agent-kernel/kernel'

import { Button } from '../../components/ui/button.js'

/**
 * Banner shown above the composer when the session is close to hitting the
 * context window. Two tiers, matching the kernel's `contextPressureLevel`:
 *   - soft (>= config.softThreshold): amber, offers a manual "Compact now".
 *   - hard (>= config.hardThreshold): rose, waits for the auto-compact tool
 *     call already being enqueued by the host.
 * Idle sessions render nothing.
 */
type Props = {
  state: AgentState | null
  compactRunning: boolean
  onCompactNow: () => void
}

export function ContextPressureBanner({
  state,
  compactRunning,
  onCompactNow,
}: Props): JSX.Element | null {
  const { t } = useTranslation()
  const level = state?.contextPressureLevel ?? 'none'
  if (level === 'none') return null

  if (level === 'hard') {
    return (
      <div
        className="flex items-center gap-2 border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
        data-testid="context-pressure-banner"
        data-level="hard"
        role="status"
      >
        <AlertTriangle className="h-3.5 w-3.5 flex-none" />
        <span className="font-medium">{t('contextPressure.full')}</span>
        <span className="truncate text-rose-700/80 dark:text-rose-200/70">
          {compactRunning
            ? t('contextPressure.fullRunning')
            : t('contextPressure.fullQueued')}
        </span>
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      data-testid="context-pressure-banner"
      data-level="soft"
      role="status"
    >
      <Zap className="h-3.5 w-3.5 flex-none" />
      <span className="font-medium">{t('contextPressure.gettingFull')}</span>
      <span className="truncate text-amber-700/80 dark:text-amber-200/75">
        {t('contextPressure.compactHint')}
      </span>
      <div className="ml-auto flex-none">
        <Button
          type="button"
          size="sm"
          onClick={onCompactNow}
          disabled={compactRunning}
          data-testid="context-pressure-compact-now"
          className="h-6 px-2 bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
        >
          {compactRunning ? t('contextPressure.compacting') : t('contextPressure.compactNow')}
        </Button>
      </div>
    </div>
  )
}
