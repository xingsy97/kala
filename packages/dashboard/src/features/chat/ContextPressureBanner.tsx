import { useEffect, useMemo, useState } from 'react'
import { X, Zap } from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'

import type { AgentState } from '@agent-kernel/kernel'
import type { ContextUsageSnapshot } from '@agent-kernel/shared/context-usage'

import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'
import { evaluateDashboardContextPressure } from '../../domain/context-pressure.js'
import { BannerSlot } from './BannerStack.js'

/**
 * Banner shown above the composer when the session is close to the context
 * window and there's still a user action to take. Soft tier (>= softThreshold)
 * offers a manual "Compact now" button.
 *
 * Hard-tier auto-compact used to also render here, but that made an in-progress
 * background action look like a static warning. It now surfaces as a
 * queued/running CompactFeedbackRow inside the transcript instead — same
 * component tool-call cards use, so the "something is happening" affordance
 * matches user expectations.
 */
type Props = {
  state: AgentState | null
  contextSnapshot: ContextUsageSnapshot | null
  compactRunning: boolean
  suppressed?: boolean
  onCompactNow: () => void
}

export function ContextPressureBanner({
  state,
  contextSnapshot,
  compactRunning,
  suppressed,
  onCompactNow,
}: Props): JSX.Element | null {
  const { t } = useTranslation()
  const pressure = evaluateDashboardContextPressure({ snapshot: contextSnapshot })
  const active = isActiveTurn(state?.status)
  const shouldShow = !suppressed && pressure.level === 'high' && !active
  // Re-emerge after dismissal if the pressure level shifts (e.g. compact
  // brought it down and it rose again). Signature captures the trigger.
  const signature = useMemo(() => `${pressure.level}:${pressure.percent ?? 'n/a'}`, [pressure.level, pressure.percent])
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null)
  useEffect(() => {
    if (!shouldShow) setDismissedSignature(null)
  }, [shouldShow])
  if (!shouldShow) return null
  if (dismissedSignature === signature) return null

  return (
    <BannerSlot>
      <motion.div
        className="flex min-w-0 items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        data-testid="context-pressure-banner"
        data-level={pressure.level}
        role="status"
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <Zap className="h-3.5 w-3.5 flex-none" />
        <span className="flex-none font-medium">{t('contextPressure.gettingFull')}</span>
        <span className="min-w-0 flex-1 truncate text-amber-700/80 dark:text-amber-200/75">
          {t('contextPressure.compactHint')}
        </span>
        <div className="ml-auto flex flex-none items-center gap-1">
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
          <button
            type="button"
            onClick={() => setDismissedSignature(signature)}
            aria-label={t('contextPressure.dismiss')}
            title={t('contextPressure.dismiss')}
            data-testid="context-pressure-dismiss"
            className={cn(
              'rounded p-0.5 text-amber-700/80 transition-colors hover:bg-amber-100 hover:text-amber-900',
              'dark:text-amber-300/80 dark:hover:bg-amber-900/60 dark:hover:text-amber-100',
            )}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </motion.div>
    </BannerSlot>
  )
}

function isActiveTurn(status: AgentState['status'] | undefined): boolean {
  return status === 'thinking' || status === 'executing_tools' || status === 'awaiting_approval'
}
