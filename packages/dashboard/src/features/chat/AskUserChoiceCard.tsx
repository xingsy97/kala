import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Check, HelpCircle, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AskUserChoiceRequest } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { Textarea } from '../../components/ui/textarea.js'
import { cn } from '../../lib/utils.js'

export type AskUserChoiceDraft =
  | { kind: 'choice'; value: string }
  | { kind: 'custom'; text: string }

type Props = {
  sessionScope: string
  requests: readonly AskUserChoiceRequest[]
  onSubmit(callId: string, draft: AskUserChoiceDraft): Promise<void>
  onReject(callId: string): Promise<void>
}

type SubmissionPhase =
  | { kind: 'idle' }
  | { kind: 'submitting'; action: 'submit' | 'reject' }
  | { kind: 'accepted'; action: 'submit' | 'reject' }
  | { kind: 'error'; message: string }

export function AskUserChoiceCard({ sessionScope, requests, onSubmit, onReject }: Props): JSX.Element | null {
  const [current, setCurrent] = useState(0)
  const request = requests[current] ?? null

  useEffect(() => {
    if (requests.length === 0) {
      setCurrent(0)
      return
    }
    if (current >= requests.length) setCurrent(requests.length - 1)
  }, [current, requests.length])

  useEffect(() => {
    setCurrent(0)
  }, [sessionScope])

  if (!request) return null

  return (
    <AskUserChoiceRequestCard
      key={requestIdentity(sessionScope, request)}
      request={request}
      requestIdentity={requestIdentity(sessionScope, request)}
      current={current}
      total={requests.length}
      onSubmit={onSubmit}
      onReject={onReject}
    />
  )
}

function AskUserChoiceRequestCard({
  request,
  requestIdentity,
  current,
  total,
  onSubmit,
  onReject,
}: {
  request: AskUserChoiceRequest
  requestIdentity: string
  current: number
  total: number
  onSubmit: Props['onSubmit']
  onReject: Props['onReject']
}): JSX.Element {
  const { t } = useTranslation()
  const initialValue = request.defaultValue ?? request.choices[0]?.value ?? ''
  const [draft, setDraft] = useState<AskUserChoiceDraft>({ kind: 'choice', value: initialValue })
  const [phase, setPhase] = useState<SubmissionPhase>({ kind: 'idle' })
  const submissionLock = useRef(false)
  const generation = useRef(0)
  const disabled = phase.kind === 'submitting' || phase.kind === 'accepted'
  const trimmedCustomText = draft.kind === 'custom' ? draft.text.trim() : ''
  const canSubmit = draft.kind === 'choice' ? draft.value.length > 0 : trimmedCustomText.length > 0
  const selectedLabel = useMemo(() => {
    if (draft.kind === 'custom') return t('chat.askUser.customSelection')
    return request.choices.find((choice) => choice.value === draft.value)?.label ?? draft.value
  }, [draft, request.choices, t])

  useEffect(() => {
    generation.current += 1
    submissionLock.current = false
    setDraft({ kind: 'choice', value: initialValue })
    setPhase({ kind: 'idle' })
    return () => { generation.current += 1 }
  }, [initialValue, requestIdentity])

  const runAction = async (action: 'submit' | 'reject'): Promise<void> => {
    if (submissionLock.current || disabled || (action === 'submit' && !canSubmit)) return
    submissionLock.current = true
    const actionGeneration = generation.current
    setPhase({ kind: 'submitting', action })
    try {
      if (action === 'reject') {
        await onReject(request.callId)
      } else {
        const response = draft.kind === 'custom'
          ? { kind: 'custom' as const, text: trimmedCustomText }
          : draft
        await onSubmit(request.callId, response)
      }
      if (generation.current === actionGeneration) setPhase({ kind: 'accepted', action })
    } catch (error) {
      if (generation.current !== actionGeneration) return
      submissionLock.current = false
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
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
      aria-busy={phase.kind === 'submitting'}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/45 bg-muted/25 px-3 py-2.5">
        <span className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
          <HelpCircle className="h-4 w-4" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('chat.askUser.required')}
        </span>
        {total > 1 ? (
          <span className="ml-1 rounded-full bg-background/80 px-2 py-0.5 text-[0.625rem] font-medium tabular-nums text-muted-foreground ring-1 ring-border/50">
            {t('chat.askUser.index', { current: current + 1, total })}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3 px-3 py-2.5">
        {request.intent ? <p className="text-sm leading-6 text-muted-foreground">{request.intent}</p> : null}
        <p className="text-[0.9375rem] font-medium leading-6 text-foreground" data-testid="ask-user-choice-message">
          {request.message}
        </p>
        <fieldset className="grid gap-1.5 sm:grid-cols-2" aria-label={request.message}>
          <legend className="sr-only">{request.message}</legend>
          {request.choices.map((choice) => {
            const active = draft.kind === 'choice' && choice.value === draft.value
            return (
              <label
                key={choice.value}
                className={cn(
                  'relative min-w-0 rounded-xl border px-3 py-2.5 text-left transition focus-within:ring-2 focus-within:ring-primary/45',
                  disabled && 'cursor-not-allowed opacity-60',
                  active
                    ? 'border-primary/45 bg-primary/10 text-foreground shadow-sm ring-1 ring-primary/20'
                    : 'border-border/55 bg-background/55 text-foreground/90 hover:bg-muted/65',
                )}
              >
                <input
                  type="radio"
                  name={`ask-user-choice-${encodeURIComponent(requestIdentity)}`}
                  value={choice.value}
                  checked={active}
                  aria-checked={active}
                  disabled={disabled}
                  data-testid={`ask-user-choice-option-${choice.value}`}
                  onChange={() => {
                    setDraft({ kind: 'choice', value: choice.value })
                    if (phase.kind === 'error') setPhase({ kind: 'idle' })
                  }}
                  className="sr-only"
                />
                <span className="block truncate text-sm font-medium">{choice.label ?? choice.value}</span>
                {choice.description ? (
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{choice.description}</span>
                ) : null}
              </label>
            )
          })}
          <label
            className={cn(
              'relative min-w-0 rounded-xl border px-3 py-2.5 text-left transition focus-within:ring-2 focus-within:ring-primary/45 sm:col-span-2',
              disabled && 'cursor-not-allowed opacity-60',
              draft.kind === 'custom'
                ? 'border-primary/45 bg-primary/10 text-foreground shadow-sm ring-1 ring-primary/20'
                : 'border-border/55 bg-background/55 text-foreground/90 hover:bg-muted/65',
            )}
            data-testid="ask-user-choice-custom-option"
          >
            <input
              type="radio"
              name={`ask-user-choice-${encodeURIComponent(requestIdentity)}`}
              checked={draft.kind === 'custom'}
              disabled={disabled}
              onChange={() => {
                setDraft({ kind: 'custom', text: '' })
                if (phase.kind === 'error') setPhase({ kind: 'idle' })
              }}
              className="sr-only"
            />
            <span className="block text-sm font-medium">{t('chat.askUser.customLabel')}</span>
          </label>
        </fieldset>
        <div
          className={cn(
            'rounded-xl border bg-background/55 p-2.5 transition',
            draft.kind === 'custom'
              ? 'border-primary/45 bg-primary/10 shadow-sm ring-1 ring-primary/20'
              : 'border-border/55',
          )}
          data-testid="ask-user-choice-custom"
          data-selected={draft.kind === 'custom' ? 'true' : 'false'}
        >
          <label htmlFor={`ask-user-choice-custom-${request.callId}`} className="block text-xs font-medium text-muted-foreground">
            {t('chat.askUser.customLabel')}
          </label>
          <Textarea
            id={`ask-user-choice-custom-${request.callId}`}
            value={draft.kind === 'custom' ? draft.text : ''}
            onChange={(event) => {
              setDraft({ kind: 'custom', text: event.target.value })
              if (phase.kind === 'error') setPhase({ kind: 'idle' })
            }}
            disabled={disabled || draft.kind !== 'custom'}
            maxLength={4000}
            placeholder={t('chat.askUser.customPlaceholder')}
            data-testid="ask-user-choice-custom-input"
            className="mt-1 min-h-[84px] border-border/60 bg-card/80 text-foreground placeholder:text-muted-foreground/60 focus-visible:ring-primary/35"
          />
        </div>
        {phase.kind === 'error' ? (
          <p className="text-sm text-destructive" role="alert" data-testid="ask-user-choice-error">
            {t('chat.askUser.submitError', { error: phase.message })}
          </p>
        ) : null}
        {phase.kind === 'submitting' ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground" role="status" data-testid="ask-user-choice-status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {phase.action === 'submit' ? t('chat.askUser.submitting') : t('chat.askUser.rejecting')}
          </p>
        ) : null}
        {phase.kind === 'accepted' ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground" role="status" data-testid="ask-user-choice-status">
            <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            {phase.action === 'submit' ? t('chat.askUser.submitted') : t('chat.askUser.rejected')}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {t('chat.askUser.selected', { value: selectedLabel })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => { void runAction('reject') }}
            disabled={disabled}
            data-testid="ask-user-choice-reject-all"
            className="h-8 flex-none border-border/70 px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="mr-1 h-4 w-4" />
            {t('chat.askUser.rejectAll')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => { void runAction('submit') }}
            disabled={disabled || !canSubmit}
            data-testid="ask-user-choice-submit"
            className="h-8 flex-none bg-primary px-4 text-primary-foreground shadow hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            {phase.kind === 'submitting' && phase.action === 'submit' ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="mr-1 h-4 w-4" />
            )}
            {t('chat.askUser.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function requestIdentity(sessionScope: string, request: AskUserChoiceRequest): string {
  return JSON.stringify([
    sessionScope,
    request.sessionId,
    request.callId,
    request.message,
    request.intent ?? null,
    request.defaultValue ?? null,
    request.choices.map((choice) => [choice.value, choice.label ?? null, choice.description ?? null]),
  ])
}
