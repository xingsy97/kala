import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { saveFile } from '../../lib/save-file.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js'
import { Button } from '../../components/ui/button.js'

type FailureCategory =
  | 'patch-apply-failure'
  | 'test-timeout'
  | 'agent-error'
  | 'infra-error'
  | 'verifier-failure'
  | 'unresolved-other'

type BadCaseLabel =
  | 'not-a-bug'
  | 'needs-more-context'
  | 'model-limitation'
  | 'infra-flake'
  | 'worth-retraining'

const CATEGORY_ORDER: readonly FailureCategory[] = [
  'patch-apply-failure',
  'test-timeout',
  'agent-error',
  'infra-error',
  'verifier-failure',
  'unresolved-other',
]

const LABELS: readonly BadCaseLabel[] = [
  'not-a-bug',
  'needs-more-context',
  'model-limitation',
  'infra-flake',
  'worth-retraining',
]

type BadCase = {
  instanceId: string
  failureCategory: FailureCategory
  traceHead: string[]
  traceTail: string[]
  toolCallErrors: string[]
  verifierReason?: string
  minimalRepro?: string
  annotation?: { label: BadCaseLabel; note?: string; updatedAt: string }
}

type BadCaseListResponse = {
  runId: string
  counts: Record<FailureCategory, number>
  cases: BadCase[]
}

type ExportResponse = {
  format: 'sft' | 'rl'
  count: number
  content: string
}

type RolloutExportResponse = {
  target: 'verl' | 'slime'
  rolloutCount: number
  content: string
}

export type BadCasesTabProps = {
  initialRunId?: string
  lockedRun?: boolean
}

export function BadCasesTab({ initialRunId = '', lockedRun = false }: BadCasesTabProps): JSX.Element {
  const { t } = useTranslation()
  const [runId, setRunId] = useState(initialRunId)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<BadCaseListResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<'sft' | 'rl'>('sft')
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})
  const [savedFlash, setSavedFlash] = useState<Record<string, string>>({})
  const [rolloutTarget, setRolloutTarget] = useState<'verl' | 'slime'>('verl')
  const [rolloutStatusFilter, setRolloutStatusFilter] = useState('completed,resolved')
  const [rolloutDone, setRolloutDone] = useState<number | null>(null)
  const [rolloutError, setRolloutError] = useState<string | null>(null)
  const [availableRuns, setAvailableRuns] = useState<Array<{ runId: string; label: string }>>([])
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [exportOpen, setExportOpen] = useState(false)

  const loadAvailableRuns = (): void => {
    if (availableRuns.length > 0) return
    void fetch('/enhancement/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run-registry-list' }) })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { runs?: Array<{ runId: string; label: string }> } | null) => setAvailableRuns(payload?.runs ?? []))
      .catch(() => {})
  }

  const grouped = useMemo(() => {
    const map = new Map<FailureCategory, BadCase[]>()
    if (!data) return map
    const needle = query.trim().toLowerCase()
    for (const c of data.cases) {
      if (needle && !`${c.instanceId} ${c.failureCategory} ${c.verifierReason ?? ''} ${c.toolCallErrors.join(' ')}`.toLowerCase().includes(needle)) continue
      const list = map.get(c.failureCategory) ?? []
      list.push(c)
      map.set(c.failureCategory, list)
    }
    return map
  }, [data, query])

  const loadMutation = useMutation({
    mutationFn: async (id: string): Promise<BadCaseListResponse> => {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'badcase-list', runId: id }),
      })
      const payload = await res.json() as BadCaseListResponse | { error?: string }
      if (!res.ok) throw new Error((payload as { error?: string }).error ?? `status ${res.status}`)
      return payload as BadCaseListResponse
    },
    onSuccess: (payload) => {
      setData(payload)
      setSelected(new Set())
      setActiveInstanceId(payload.cases[0]?.instanceId ?? null)
      setError(null)
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err))
      setData(null)
    },
  })
  const loading = loadMutation.isPending
  const load = useCallback((): void => {
    if (!runId.trim()) return
    loadMutation.mutate(runId.trim())
  }, [runId, loadMutation])
  useEffect(() => {
    if (lockedRun && initialRunId) loadMutation.mutate(initialRunId)
    // The selected experiment changes by component key in RunDetailPanel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedRun, initialRunId])

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    if (!data) return
    setSelected((prev) => {
      if (prev.size === data.cases.length) return new Set()
      return new Set(data.cases.map((c) => c.instanceId))
    })
  }, [data])

  const annotateMutation = useMutation({
    mutationFn: async (vars: { runId: string; instanceId: string; label: BadCaseLabel; note?: string }): Promise<{ updatedAt: string; instanceId: string; label: BadCaseLabel; note?: string }> => {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'badcase-annotate',
          runId: vars.runId,
          instanceId: vars.instanceId,
          label: vars.label,
          ...(vars.note ? { note: vars.note } : {}),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `status ${res.status}`)
      }
      const payload = await res.json() as { updatedAt: string }
      return { ...payload, instanceId: vars.instanceId, label: vars.label, note: vars.note }
    },
    onSuccess: (result) => {
      setData((current) => current ? {
        ...current,
        cases: current.cases.map((c) => c.instanceId === result.instanceId
          ? { ...c, annotation: { label: result.label, ...(result.note ? { note: result.note } : {}), updatedAt: result.updatedAt } }
          : c),
      } : current)
      setSavedFlash((prev) => ({ ...prev, [result.instanceId]: result.updatedAt }))
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err))
    },
  })
  const annotate = useCallback((instanceId: string, label: BadCaseLabel): void => {
    if (!data) return
    annotateMutation.mutate({ runId: data.runId, instanceId, label, note: noteDraft[instanceId] })
  }, [data, noteDraft, annotateMutation])

  const exportMutation = useMutation({
    mutationFn: async (vars: { runId: string; instanceIds: string[]; format: 'sft' | 'rl' }): Promise<ExportResponse & { runId: string; format: 'sft' | 'rl' }> => {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'badcase-export',
          runId: vars.runId,
          instanceIds: vars.instanceIds,
          format: vars.format,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `status ${res.status}`)
      }
      const payload = await res.json() as ExportResponse
      return { ...payload, runId: vars.runId, format: vars.format }
    },
    onSuccess: (payload) => {
      void saveFile({ blob: new Blob([payload.content], { type: 'application/x-ndjson' }), suggestedName: `badcases-${payload.runId}-${payload.format}.jsonl` })
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err))
    },
  })
  const exportSelected = useCallback((): void => {
    if (!data || selected.size === 0) return
    exportMutation.mutate({ runId: data.runId, instanceIds: [...selected], format })
  }, [data, selected, format, exportMutation])

  const rolloutMutation = useMutation({
    mutationFn: async (vars: { runId: string; target: 'verl' | 'slime'; includeStatuses: string[] }): Promise<RolloutExportResponse & { runId: string; target: 'verl' | 'slime' }> => {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'rollout-export',
          runId: vars.runId,
          target: vars.target,
          ...(vars.includeStatuses.length > 0 ? { includeStatuses: vars.includeStatuses } : {}),
        }),
      })
      const body = await res.json().catch(() => null) as RolloutExportResponse | { error?: string } | null
      if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `status ${res.status}`)
      const payload = body as RolloutExportResponse
      return { ...payload, runId: vars.runId, target: vars.target }
    },
    onMutate: () => {
      setRolloutError(null)
      setRolloutDone(null)
    },
    onSuccess: (payload) => {
      void saveFile({ blob: new Blob([payload.content], { type: 'application/x-ndjson' }), suggestedName: `rollouts-${payload.runId}-${payload.target}.jsonl` })
      setRolloutDone(payload.rolloutCount)
    },
    onError: (err) => {
      setRolloutError(err instanceof Error ? err.message : String(err))
    },
  })
  const rolloutExporting = rolloutMutation.isPending
  const activeCase = data?.cases.find((item) => item.instanceId === activeInstanceId) ?? null
  const exportRollouts = useCallback((): void => {
    const activeRunId = data?.runId ?? runId.trim()
    if (!activeRunId) return
    const includeStatuses = rolloutStatusFilter
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    rolloutMutation.mutate({ runId: activeRunId, target: rolloutTarget, includeStatuses })
  }, [data, runId, rolloutTarget, rolloutStatusFilter, rolloutMutation])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4" data-testid="badcases-tab">
      <div className="flex items-end gap-2">
        {!lockedRun ? <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('artifacts.badcases.runIdLabel')}</span>
          <select className="rounded border border-border bg-background px-2 py-1 text-sm" value={runId} onFocus={loadAvailableRuns} onMouseDown={loadAvailableRuns} onChange={(e) => setRunId(e.target.value)} data-testid="badcases-runid">
            <option value="">{t('artifacts.badcases.runIdPlaceholder')}</option>
            {availableRuns.map((run) => <option key={run.runId} value={run.runId}>{run.label}</option>)}
          </select>
        </label> : <div className="text-sm"><div className="text-xs text-muted-foreground">{t('artifacts.badcases.currentExperiment')}</div><div className="font-medium">{t('artifacts.badcases.currentExperimentHint')}</div></div>}
        {!lockedRun ? <button type="button" className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50" onClick={() => load()} disabled={loading || !runId.trim()} data-testid="badcases-load">{loading ? t('artifacts.badcases.loading') : t('artifacts.badcases.load')}</button> : loading ? <span className="text-sm text-muted-foreground">{t('artifacts.badcases.loading')}</span> : null}
        <div className="ml-auto"><button type="button" className="rounded border border-border px-3 py-1.5 text-sm" onClick={() => setExportOpen(true)} data-testid="badcases-export-open">{t('artifacts.badcases.export')}</button></div>
      </div>

      {error ? (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive" data-testid="badcases-error">
          {t('artifacts.badcases.error', { message: error })}
        </div>
      ) : null}

      <Dialog open={exportOpen} onOpenChange={setExportOpen}><DialogContent data-testid="badcases-export-dialog"><DialogHeader><DialogTitle>{t('artifacts.badcases.exportTitle')}</DialogTitle><DialogDescription>{t('artifacts.badcases.exportDescription')}</DialogDescription></DialogHeader><div className="space-y-4"><section className="rounded border border-border p-3"><label className="grid gap-1 text-sm"><span>{t('artifacts.badcases.formatLabel')}</span><select className="h-9 rounded border border-border bg-background px-2" value={format} onChange={(e) => setFormat(e.target.value === 'rl' ? 'rl' : 'sft')} data-testid="badcases-format"><option value="sft">{t('artifacts.badcases.formats.sft')}</option><option value="rl">{t('artifacts.badcases.formats.rl')}</option></select></label><Button className="mt-3 w-full" onClick={() => exportSelected()} disabled={!data || selected.size === 0} data-testid="badcases-export">{t('artifacts.badcases.exportSelected')} ({selected.size})</Button></section>
      <section
        className="rounded border border-border p-3 text-xs"
        data-testid="rollouts-export-section"
      >
        <header className="mb-1 flex items-center gap-2">
          <span className="text-sm font-medium">{t('artifacts.rollouts.title')}</span>
          <span className="text-muted-foreground">{t('artifacts.rollouts.description')}</span>
        </header>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t('artifacts.rollouts.targetLabel')}</span>
            <select
              className="rounded border border-border bg-background px-2 py-1 text-sm"
              value={rolloutTarget}
              onChange={(e) => setRolloutTarget(e.target.value === 'slime' ? 'slime' : 'verl')}
              data-testid="rollouts-target"
            >
              <option value="verl">{t('artifacts.rollouts.targets.verl')}</option>
              <option value="slime">{t('artifacts.rollouts.targets.slime')}</option>
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-muted-foreground">{t('artifacts.rollouts.statusFilterLabel')}</span>
            <select className="rounded border border-border bg-background px-2 py-1 text-sm" value={rolloutStatusFilter} onChange={(e) => setRolloutStatusFilter(e.target.value)} data-testid="rollouts-status-filter">
              <option value="">{t('artifacts.rollouts.statusFilterPlaceholder')}</option>
              <option value="completed,resolved">completed + resolved</option>
              <option value="completed, resolved">completed + resolved</option>
              <option value="failed,timed_out">failed + timed_out</option>
              {['resolved', 'failed', 'timed_out', 'completed'].map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => { exportRollouts() }}
            disabled={rolloutExporting || !runId.trim()}
            data-testid="rollouts-export-button"
          >
            {rolloutExporting ? t('artifacts.rollouts.exporting') : t('artifacts.rollouts.exportButton')}
          </button>
        </div>
        {rolloutDone !== null ? (
          <div className="mt-1 text-muted-foreground" data-testid="rollouts-export-done">
            {rolloutDone === 0
              ? t('artifacts.rollouts.empty')
              : t('artifacts.rollouts.done', { count: rolloutDone })}
          </div>
        ) : null}
        {rolloutError ? (
          <div className="mt-1 text-destructive" data-testid="rollouts-export-error">
            {t('artifacts.rollouts.error', { message: rolloutError })}
          </div>
        ) : null}
      </section></div><DialogFooter><Button variant="outline" onClick={() => setExportOpen(false)}>{t('common.close')}</Button></DialogFooter></DialogContent></Dialog>

      {data && data.cases.length === 0 && !loading ? (
        <div className="text-sm text-muted-foreground" data-testid="badcases-empty">
          {t('artifacts.badcases.empty')}
        </div>
      ) : null}

      {data && data.cases.length > 0 ? (
        <div className="flex items-center gap-2 text-xs">
          <button type="button" className="underline" onClick={toggleAll} data-testid="badcases-select-all">
            {t('artifacts.badcases.selectAll')}
          </button>
          <span className="text-muted-foreground">
            {CATEGORY_ORDER.filter((cat) => (data.counts[cat] ?? 0) > 0).map((cat) => (
              <span key={cat} className="mr-2">{t(`artifacts.badcases.categories.${cat}`)}: {data.counts[cat]}</span>
            ))}
          </span>
        </div>
      ) : null}

      {data?.cases.length ? (
        <div className="grid min-h-[420px] flex-1 grid-cols-[minmax(260px,32%)_minmax(0,1fr)] overflow-hidden rounded-lg border border-border max-lg:grid-cols-1" data-testid="badcases-explorer">
          <aside className="min-h-0 overflow-auto border-r border-border bg-muted/20 p-3 max-lg:max-h-72 max-lg:border-b max-lg:border-r-0">
            <input className="mb-3 h-9 w-full rounded-md border border-border bg-background px-3 text-sm" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('artifacts.badcases.searchPlaceholder')} data-testid="badcases-search" />
            {[...grouped.entries()].sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0])).map(([category, list]) => (
              <section key={category} className="mb-4" data-testid={`badcases-group-${category}`}>
                <header className="mb-1 px-1 text-sm font-semibold text-muted-foreground">{t(`artifacts.badcases.categories.${category}`)} ({list.length})</header>
                <ul className="space-y-1">
                  {list.map((c) => (
                    <li key={c.instanceId} data-testid={`badcases-row-${c.instanceId}`}>
                      <button type="button" onClick={() => setActiveInstanceId(c.instanceId)} className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${activeInstanceId === c.instanceId ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted'}`}>
                        <input type="checkbox" checked={selected.has(c.instanceId)} onChange={() => toggle(c.instanceId)} onClick={(event) => event.stopPropagation()} aria-label={`select ${c.instanceId}`} data-testid={`badcases-check-${c.instanceId}`} />
                        <span className="min-w-0 flex-1 truncate font-medium">{c.instanceId}</span>
                        {(c.toolCallErrors.length > 0 || c.verifierReason) ? <span className="h-2 w-2 rounded-full bg-rose-500" aria-hidden="true" /> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </aside>
          <main className="min-h-0 overflow-auto bg-background p-5 text-sm" data-testid="badcases-detail">
            {activeCase ? <BadCaseDetail badCase={activeCase} note={noteDraft[activeCase.instanceId] ?? activeCase.annotation?.note ?? ''} saved={!!savedFlash[activeCase.instanceId]} onNote={(note) => setNoteDraft((prev) => ({ ...prev, [activeCase.instanceId]: note }))} onAnnotate={(label) => annotate(activeCase.instanceId, label)} t={t} /> : <div className="text-muted-foreground">{t('artifacts.badcases.selectCase')}</div>}
          </main>
        </div>
      ) : null}
    </div>
  )
}

function BadCaseDetail({ badCase, note, saved, onNote, onAnnotate, t }: { badCase: BadCase; note: string; saved: boolean; onNote(note: string): void; onAnnotate(label: BadCaseLabel): void; t: TFunction }): JSX.Element {
  const explanation = explainBadCase(badCase, t)
  return (
    <article className="mx-auto max-w-5xl space-y-5">
      <header className="border-b border-border pb-4"><h2 className="break-all font-mono text-xl font-semibold">{badCase.instanceId}</h2><span className="mt-2 inline-flex rounded-full bg-rose-500/10 px-3 py-1 text-sm font-medium text-rose-700 dark:text-rose-300">{t(`artifacts.badcases.categories.${badCase.failureCategory}`)}</span></header>
      <section className="rounded-xl border border-primary/25 bg-primary/5 p-5"><h3 className="text-base font-semibold">{t('artifacts.badcases.plainSummary')}</h3><p className="mt-2 text-base leading-7">{explanation.summary}</p></section>
      <div className="grid gap-3 md:grid-cols-3"><PlainCard title={t('artifacts.badcases.whatChanged')} text={explanation.changed} /><PlainCard title={t('artifacts.badcases.whyFailed')} text={explanation.failed} /><PlainCard title={t('artifacts.badcases.nextCheck')} text={explanation.next} /></div>
      <details className="rounded-lg border border-border bg-muted/20"><summary className="cursor-pointer px-4 py-3 text-sm font-semibold">{t('artifacts.badcases.technicalDetails')}</summary><div className="space-y-4 border-t border-border p-4">{badCase.verifierReason ? <DetailSection title={t('artifacts.badcases.verifierReason')} content={badCase.verifierReason} emphasis /> : null}{badCase.minimalRepro ? <DetailSection title={t('artifacts.badcases.minimalRepro')} content={badCase.minimalRepro} /> : null}{badCase.traceHead.length ? <DetailSection title={t('artifacts.badcases.traceHead')} content={badCase.traceHead.join('\n')} /> : null}{badCase.traceTail.length ? <DetailSection title={t('artifacts.badcases.traceTail')} content={badCase.traceTail.join('\n')} /> : null}{badCase.toolCallErrors.length ? <DetailSection title={t('artifacts.badcases.toolErrors')} content={badCase.toolCallErrors.join('\n')} /> : null}</div></details>
      <section className="rounded-lg border border-border bg-muted/20 p-4"><h3 className="mb-3 text-base font-semibold">{t('artifacts.badcases.annotation')}</h3><select className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm" value={badCase.annotation?.label ?? ''} onChange={(event) => { if (LABELS.includes(event.target.value as BadCaseLabel)) onAnnotate(event.target.value as BadCaseLabel) }} data-testid={`badcases-label-${badCase.instanceId}`}><option value="" disabled>--</option>{LABELS.map((label) => <option key={label} value={label}>{t(`artifacts.badcases.labels.${label}`)}</option>)}</select><textarea className="mt-3 min-h-28 w-full rounded-md border border-border bg-background p-3 text-sm leading-6" placeholder={t('artifacts.badcases.notePlaceholder')} value={note} onChange={(event) => onNote(event.target.value)} aria-label={t('artifacts.badcases.note')} data-testid={`badcases-note-${badCase.instanceId}`} />{saved ? <div className="mt-2 text-sm text-emerald-600">{t('artifacts.badcases.annotationSaved')}</div> : null}</section>
    </article>
  )
}

function PlainCard({ title, text }: { title: string; text: string }): JSX.Element {
  return <section className="rounded-lg border border-border bg-card p-4"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{text}</p></section>
}

function explainBadCase(badCase: BadCase, t: TFunction): { summary: string; changed: string; failed: string; next: string } {
  const changed = badCase.traceHead[0] ?? t('artifacts.badcases.explanation.changedUnknown')
  const failed = badCase.verifierReason?.split('\n')[0] ?? badCase.toolCallErrors[0] ?? t('artifacts.badcases.explanation.failedUnknown')
  const next = badCase.traceTail[0] ?? badCase.minimalRepro ?? t('artifacts.badcases.explanation.nextUnknown')
  return { summary: t('artifacts.badcases.explanation.summary', { changed, failed }), changed, failed, next }
}

function DetailSection({ title, content, emphasis = false }: { title: string; content: string; emphasis?: boolean }): JSX.Element {
  return <section className={`rounded-lg border p-4 ${emphasis ? 'border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/20' : 'border-border bg-muted/20'}`}><h3 className="mb-3 text-base font-semibold">{title}</h3><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-4 font-mono text-sm leading-6 ring-1 ring-border/60">{content}</pre></section>
}
