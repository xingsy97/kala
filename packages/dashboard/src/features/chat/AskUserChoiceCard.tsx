import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react'
import { Check, HelpCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AskUserChoiceRequest } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { Textarea } from '../../components/ui/textarea.js'
import { cn } from '../../lib/utils.js'

type Props = {
  requests: readonly AskUserChoiceRequest[]
  onChoose(callId: string, value: string): void
  onCustomText(callId: string, text: string): void
  onRejectAll(callId: string): void
}

export function AskUserChoiceCard({ requests, onChoose, onCustomText, onRejectAll }: Props): JSX.Element | null {
  const { t } = useTranslation()
  const [current, setCurrent] = useState(0)
  const request = requests[current] ?? null
  const [selected, setSelected] = useState<string>('')
  const [customText, setCustomText] = useState<string>('')

  useEffect(() => {
    if (requests.length === 0) {
      setCurrent(0)
      setSelected('')
      setCustomText('')
      return
    }
    if (current >= requests.length) setCurrent(requests.length - 1)
  }, [current, requests.length])

  useEffect(() => {
    if (!request) return
    const fallback = request.defaultValue ?? request.choices[0]?.value ?? ''
    setSelected((existing) => request.choices.some((choice) => choice.value === existing) ? existing : fallback)
    setCustomText('')
  }, [request])

  const selectedLabel = useMemo(
    () => request?.choices.find((choice) => choice.value === selected)?.label ?? selected,
    [request, selected],
  )
  const trimmedCustomText = customText.trim()

  if (!request) return null

  const submit = (): void => {
    if (!selected) return
    onChoose(request.callId, selected)
  }
  const submitCustomText = (): void => {
    if (trimmedCustomText.length === 0) return
    onCustomText(request.callId, trimmedCustomText)
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLTextAreaElement) return
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/95 text-card-foreground shadow-sm',
        'backdrop-blur supports-[backdrop-filter]:bg-card/85',
      )}
      data-testid="ask-user-choice-card"
      role="dialog"
      aria-label={t('chat.askUser.requiredAria')}
      onKeyDown={onKey}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/45 bg-muted/25 px-3 py-2.5">
        <span className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
          <HelpCircle className="h-4 w-4" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('chat.askUser.required')}
        </span>
        {requests.length > 1 ? (
          <span className="ml-1 rounded-full bg-background/80 px-2 py-0.5 text-[0.625rem] font-medium tabular-nums text-muted-foreground ring-1 ring-border/50">
            {t('chat.askUser.index', { current: current + 1, total: requests.length })}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3 px-3 py-2.5">
        {request.intent ? <p className="text-sm leading-6 text-muted-foreground">{request.intent}</p> : null}
        <p className="text-[0.9375rem] font-medium leading-6 text-foreground" data-testid="ask-user-choice-message">
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
                  'min-w-0 rounded-xl border px-3 py-2.5 text-left transition',
                  active
                    ? 'border-primary/45 bg-primary/10 text-foreground shadow-sm ring-1 ring-primary/20'
                    : 'border-border/55 bg-background/55 text-foreground/90 hover:bg-muted/65',
                )}
              >
                <span className="block truncate text-sm font-medium">{choice.label ?? choice.value}</span>
                {choice.description ? (
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{choice.description}</span>
                ) : null}
              </button>
            )
          })}
        </div>
        <div className="rounded-xl border border-border/55 bg-background/55 p-2.5">
          <label htmlFor={`ask-user-choice-custom-${request.callId}`} className="block text-xs font-medium text-muted-foreground">
            {t('chat.askUser.customLabel')}
          </label>
          <Textarea
            id={`ask-user-choice-custom-${request.callId}`}
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
            maxLength={4000}
            placeholder={t('chat.askUser.customPlaceholder')}
            data-testid="ask-user-choice-custom-input"
            className="mt-1 min-h-[84px] border-border/60 bg-card/80 text-foreground placeholder:text-muted-foreground/60 focus-visible:ring-primary/35"
          />
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={submitCustomText}
              disabled={trimmedCustomText.length === 0}
              data-testid="ask-user-choice-custom-submit"
              className="h-8 border-border/70 px-3 text-foreground hover:bg-muted"
            >
              {t('chat.askUser.customSubmit')}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {t('chat.askUser.selected', { value: selectedLabel })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onRejectAll(request.callId)}
            data-testid="ask-user-choice-reject-all"
            className="h-8 flex-none border-border/70 px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="mr-1 h-4 w-4" />
            {t('chat.askUser.rejectAll')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={!selected}
            data-testid="ask-user-choice-submit"
            className="h-8 flex-none bg-primary px-4 text-primary-foreground shadow hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <Check className="mr-1 h-4 w-4" />
            {t('chat.askUser.submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
