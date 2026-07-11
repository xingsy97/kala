import type { TFunction } from 'i18next'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'

type Step = {
  title: string
  subtitle: string
  detail: string
  signal: string
}

type TrackKey = 'runtime' | 'benchmark'

type Slide =
  | { kind: 'step'; step: Step; index: number; total: number }
  | { kind: 'principles' }

export function PipelinePage(): JSX.Element {
  const { t } = useTranslation()
  const [track, setTrack] = useState<TrackKey>('runtime')
  const [cursor, setCursor] = useState(0)

  const runtimeSteps = t('pipeline.steps', { returnObjects: true }) as Step[]
  const benchmarkSteps = t('pipeline.benchmarkSteps', { returnObjects: true }) as Step[]
  const steps = track === 'runtime' ? runtimeSteps : benchmarkSteps

  const slides = useMemo<Slide[]>(() => {
    const stepSlides: Slide[] = steps.map((step, i) => ({
      kind: 'step',
      step,
      index: i,
      total: steps.length,
    }))
    return [...stepSlides, { kind: 'principles' }]
  }, [steps])

  const total = slides.length
  const safeCursor = Math.min(Math.max(0, cursor), total - 1)
  const current = slides[safeCursor] ?? slides[0]!

  const goto = useCallback((next: number) => {
    setCursor(Math.max(0, Math.min(total - 1, next)))
  }, [total])

  const switchTrack = useCallback((next: TrackKey) => {
    setTrack(next)
    setCursor(0)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && isEditable(target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        goto(safeCursor + 1)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        goto(safeCursor - 1)
      } else if (e.key === '1') {
        switchTrack('runtime')
      } else if (e.key === '2') {
        switchTrack('benchmark')
      } else if (e.key === 'Home') {
        goto(0)
      } else if (e.key === 'End') {
        goto(total - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goto, safeCursor, switchTrack, total])

  const trackTitle = t(`pipeline.tracks.${track}.title`)
  const footerLabel = current.kind === 'step' ? current.step.title : t('pipeline.principlesTitle')

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="pipeline-page">
      <div className="flex items-center justify-between border-b border-border/50 px-6 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
          <span className="text-foreground">{t('pipeline.title')}</span>
          <span aria-hidden="true"> - </span>
          <span>{trackTitle}</span>
        </div>
        <div className="inline-flex rounded-md border border-border/60 bg-muted/40 p-0.5" role="tablist">
          {(['runtime', 'benchmark'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={track === key}
              data-testid={`pipeline-tab-${key}`}
              onClick={() => switchTrack(key)}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition-colors',
                track === key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`pipeline.tracks.${key}.title`)}
              <span className="ml-1.5 text-[10px] text-muted-foreground/70">{key === 'runtime' ? '1' : '2'}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="mx-auto flex h-full max-w-4xl items-center justify-center px-8 py-10">
          {current.kind === 'step' ? (
            <StepSlide step={current.step} index={current.index} total={current.total} track={track} whereToLook={t('pipeline.whereToLook')} />
          ) : (
            <PrinciplesSlide t={t} />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border/50 bg-muted/20 px-6 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => goto(safeCursor - 1)}
          disabled={safeCursor === 0}
          data-testid="pipeline-prev"
          className="gap-1"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {t('pipeline.prev')}
        </Button>

        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-1.5" role="tablist" aria-label={t('pipeline.slidesLabel')}>
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={t('pipeline.slideNumber', { index: i + 1 })}
                aria-selected={i === safeCursor}
                onClick={() => goto(i)}
                data-testid={`pipeline-dot-${i}`}
                className={cn(
                  'h-2 rounded-full transition-all',
                  i === safeCursor ? 'w-6 bg-primary' : 'w-2 bg-muted-foreground/30 hover:bg-muted-foreground/60',
                )}
              />
            ))}
          </div>
          <div className="text-[11px] text-muted-foreground">
            <span className="font-mono">{safeCursor + 1} / {total}</span>
            <span className="mx-1.5"> - </span>
            <span>{footerLabel}</span>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => goto(safeCursor + 1)}
          disabled={safeCursor === total - 1}
          data-testid="pipeline-next"
          className="gap-1"
        >
          {t('pipeline.next')}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

function StepSlide({
  step,
  index,
  total,
  track,
  whereToLook,
}: {
  step: Step
  index: number
  total: number
  track: TrackKey
  whereToLook: string
}): JSX.Element {
  const accent = track === 'benchmark'
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-primary'
  return (
    <article
      className="w-full max-w-2xl"
      data-testid="pipeline-slide-step"
      data-step-index={index}
    >
      <div className={cn('font-mono text-6xl font-bold leading-none tracking-tight', accent)}>
        {String(index + 1).padStart(2, '0')}
        <span className="ml-2 text-2xl text-muted-foreground/60">/ {String(total).padStart(2, '0')}</span>
      </div>
      <h2 className="mt-6 text-3xl font-semibold tracking-tight text-foreground">{stripLeadingNumber(step.title)}</h2>
      <p className="mt-2 text-lg text-muted-foreground">{step.subtitle}</p>
      <p className="mt-6 text-base leading-8 text-foreground/90">{step.detail}</p>
      <div className="mt-8 rounded-md border-l-2 border-primary/40 bg-muted/30 px-4 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {whereToLook.replace(/[:ï - ]\s*$/, '')}
        </div>
        <p className="mt-1 text-sm leading-6 text-foreground/85">{step.signal}</p>
      </div>
    </article>
  )
}

function PrinciplesSlide({ t }: { t: TFunction }): JSX.Element {
  const keys = ['coreBoundary', 'replayFirst', 'teaching'] as const
  return (
    <article className="w-full max-w-3xl" data-testid="pipeline-slide-principles">
      <div className="font-mono text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('pipeline.principlesLabel')}
      </div>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        {t('pipeline.principlesTitle')}
      </h2>
      <div className="mt-8 space-y-5">
        {keys.map((key) => (
          <section key={key} className="rounded-md border border-border/50 bg-card/50 px-5 py-4">
            <h3 className="text-base font-semibold text-foreground">
              {t(`pipeline.principles.${key}.title`)}
            </h3>
            <p className="mt-1.5 text-sm leading-7 text-muted-foreground">
              {t(`pipeline.principles.${key}.body`)}
            </p>
          </section>
        ))}
      </div>
    </article>
  )
}

function stripLeadingNumber(title: string): string {
  return title.replace(/^\s*\d+[. - ï - )]\s*/, '')
}

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}
