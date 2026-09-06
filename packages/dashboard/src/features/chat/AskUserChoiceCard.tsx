import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react'
import { Check, HelpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AskUserChoiceRequest } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'

type Props = {
  requests: readonly AskUserChoiceRequest[]
  onChoose(callId: string, value: string): void
}

export function AskUserChoiceCard({ requests, onChoose }: Props): JSX.Element | null {
  const { t } = useTranslation()
  const [current, setCurrent] = useState(0)
  const request = requests[current] ?? null
  const [selected, setSelected] = useState<string>('')

  useEffect(() => {
    if (requests.length === 0) {
      setCurrent(0)
      setSelected('')
      return
    }
    if (current >= requests.length) setCurrent(requests.length - 1)
  }, [current, requests.length])

  useEffect(() => {
    if (!request) return
    const fallback = request.defaultValue ?? request.choices[0]?.value ?? ''
    setSelected((existing) => request.choices.some((choice) => choice.value === existing) ? existing : fallback)
  }, [request])

  const selectedLabel = useMemo(
    () => request?.choices.find((choice) => choice.value === selected)?.label ?? selected,
    [request, selected],
  )

  if (!request) return null

  const submit = (): void => {
    if (!selected) return
    onChoose(request.callId, selected)
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-lg border shadow-sm',
        'border-sky-300/70 bg-sky-50/80 text-sky-950',
        'dark:border-sky-500/40 dark:bg-sky-950/40 dark:text-sky-100',
      )}
      data-testid="ask-user-choice-card"
      role="dialog"
      aria-label={t('chat.askUser.requiredAria')}
      onKeyDown={onKey}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-sky-200/70 px-3 py-2 dark:border-sky-500/30">
        <HelpCircle className="h-4 w-4 flex-none text-sky-600 dark:text-sky-400" />
        <span className="text-xs font-semibold uppercase tracking-wide">
          {t('chat.askUser.required')}
        </span>
        {requests.length > 1 ? (
          <span className="ml-1 rounded-full bg-sky-200/60 px-2 py-0.5 text-[10px] font-medium tabular-nums text-sky-900 dark:bg-sky-500/20 dark:text-sky-100">
            {t('chat.askUser.index', { current: current + 1, total: requests.length })}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3 px-3 py-2.5">
        {request.intent ? <p className="text-xs text-sky-900/80 dark:text-sky-100/75">{request.intent}</p> : null}
        <p className="text-sm font-medium text-sky-950 dark:text-sky-50" data-testid="ask-user-choice-message">
          {request.message}
        </p>
        <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label={request.message}>
          {request.choices.map((choice) => {
            const active = choice.value === selected
            return (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`ask-user-choice-option-${choice.value}`}
                onClick={() => setSelected(choice.value)}
                className={cn(
                  'min-w-0 rounded-md border px-2.5 py-2 text-left transition',
                  active
                    ? 'border-sky-500 bg-white text-sky-950 shadow-sm ring-1 ring-sky-400/40 dark:border-sky-400 dark:bg-sky-950/70 dark:text-sky-50'
                    : 'border-sky-200/80 bg-white/50 text-sky-900 hover:bg-white dark:border-sky-500/30 dark:bg-black/10 dark:text-sky-100 dark:hover:bg-sky-950/60',
                )}
              >
                <span className="block truncate text-sm font-medium">{choice.label ?? choice.value}</span>
                {choice.description ? (
                  <span className="mt-0.5 block text-xs text-sky-800/70 dark:text-sky-200/65">{choice.description}</span>
                ) : null}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-sky-800/75 dark:text-sky-200/70">
            {t('chat.askUser.selected', { value: selectedLabel })}
          </span>
          <Button
            size="sm"
            onClick={submit}
            disabled={!selected}
            data-testid="ask-user-choice-submit"
            className="h-8 flex-none bg-sky-600 px-4 text-white shadow hover:bg-sky-700 focus-visible:ring-2 focus-visible:ring-sky-500/60 dark:bg-sky-600 dark:hover:bg-sky-500"
          >
            <Check className="mr-1 h-4 w-4" />
            {t('chat.askUser.submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
