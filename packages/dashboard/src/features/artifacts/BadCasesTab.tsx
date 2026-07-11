import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

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

export type BadCasesTabProps = {
  initialRunId?: string
}

export function BadCasesTab({ initialRunId = '' }: BadCasesTabProps): JSX.Element {
  const { t } = useTranslation()
  const [runId, setRunId] = useState(initialRunId)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<BadCaseListResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<'sft' | 'rl'>('sft')
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})
  const [savedFlash, setSavedFlash] = useState<Record<string, string>>({})

  const grouped = useMemo(() => {
    const map = new Map<FailureCategory, BadCase[]>()
    if (!data) return map
    for (const c of data.cases) {
      const list = map.get(c.failureCategory) ?? []
      list.push(c)
      map.set(c.failureCategory, list)
    }
    return map
  }, [data])

  const load = useCallback(async () => {
    if (!runId.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'badcase-list', runId: runId.trim() }),
      })
      const payload = await res.json() as BadCaseListResponse | { error?: string }
      if (!res.ok) throw new Error((payload as { error?: string }).error ?? `status ${res.status}`)
      setData(payload as BadCaseListResponse)
      setSelected(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [runId])

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

  const annotate = useCallback(async (instanceId: string, label: BadCaseLabel) => {
    if (!data) return
    try {
      const res = await fetch('/enhancement/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'badcase-annotate',
          runId: data.runId,
          instanceId,
          label,
          ...(noteDraft[instanceId] ? { note: noteDraft[instanceId] } : {}),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `status ${res.status}`)
      }
      const payload = await res.json() as { updatedAt: string }
      setData((current) => current ? {
        ...current,
        cases: current.cases.map((c) => c.instanceId === instanceId
          ? { ...c, annotation: { label, ...(noteDraft[instanceId] ? { note: noteDraft[instanceId] } : {}), updatedAt: payload.updatedAt } }
          : c),
      } : current)
      setSavedFlash((prev) => ({ ...prev, [instanceId]: payload.updatedAt }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [data, noteDraft])

  const exportSelected = useCallback(async () => {
    if (!data || selected.size === 0) return
    const res = await fetch('/enhancement/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'badcase-export',
        runId: data.runId,
        instanceIds: [...selected],
        format,
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null
      setError(body?.error ?? `status ${res.status}`)
      return
    }
    const payload = await res.json() as ExportResponse
    const blob = new Blob([payload.content], { type: 'application/x-ndjson' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `badcases-${data.runId}-${format}.jsonl`
    link.rel = 'noopener'
    link.click()
    URL.revokeObjectURL(url)
  }, [data, selected, format])

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4" data-testid="badcases-tab">
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('artifacts.badcases.runIdLabel')}</span>
          <input
            type="text"
            className="rounded border border-border bg-background px-2 py-1 text-sm"
            placeholder={t('artifacts.badcases.runIdPlaceholder')}
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
            data-testid="badcases-runid"
          />
        </label>
        <button
          type="button"
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
          onClick={() => { void load() }}
          disabled={loading || !runId.trim()}
          data-testid="badcases-load"
        >
          {loading ? t('artifacts.badcases.loading') : t('artifacts.badcases.load')}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">{t('artifacts.badcases.formatLabel')}</span>
            <select
              className="rounded border border-border bg-background px-2 py-1 text-sm"
              value={format}
              onChange={(e) => setFormat(e.target.value === 'rl' ? 'rl' : 'sft')}
              data-testid="badcases-format"
            >
              <option value="sft">{t('artifacts.badcases.formats.sft')}</option>
              <option value="rl">{t('artifacts.badcases.formats.rl')}</option>
            </select>
          </label>
          <button
            type="button"
            className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => { void exportSelected() }}
            disabled={!data || selected.size === 0}
            data-testid="badcases-export"
          >
            {t('artifacts.badcases.exportSelected')} ({selected.size})
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive" data-testid="badcases-error">
          {t('artifacts.badcases.error', { message: error })}
        </div>
      ) : null}

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

      <div className="flex-1 min-h-0 overflow-auto">
        {[...grouped.entries()]
          .sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]))
          .map(([category, list]) => (
            <section key={category} className="mb-4" data-testid={`badcases-group-${category}`}>
              <header className="mb-2 text-sm font-medium">
                {t(`artifacts.badcases.categories.${category}`)} ({list.length})
              </header>
              <ul className="flex flex-col gap-2">
                {list.map((c) => (
                  <li key={c.instanceId} className="rounded border border-border p-2 text-xs" data-testid={`badcases-row-${c.instanceId}`}>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(c.instanceId)}
                        onChange={() => toggle(c.instanceId)}
                        aria-label={`select ${c.instanceId}`}
                        data-testid={`badcases-check-${c.instanceId}`}
                      />
                      <span className="font-medium">{c.instanceId}</span>
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px]">
                        {t(`artifacts.badcases.categories.${c.failureCategory}`)}
                      </span>
                    </div>
                    {c.traceHead.length > 0 ? (
                      <div className="mt-1">
                        <div className="text-[10px] text-muted-foreground">{t('artifacts.badcases.traceHead')}</div>
                        <pre className="whitespace-pre-wrap break-all font-mono text-[10px]">{c.traceHead.join('\n')}</pre>
                      </div>
                    ) : null}
                    {c.traceTail.length > 0 ? (
                      <div className="mt-1">
                        <div className="text-[10px] text-muted-foreground">{t('artifacts.badcases.traceTail')}</div>
                        <pre className="whitespace-pre-wrap break-all font-mono text-[10px]">{c.traceTail.join('\n')}</pre>
                      </div>
                    ) : null}
                    {c.toolCallErrors.length > 0 ? (
                      <div className="mt-1">
                        <div className="text-[10px] text-muted-foreground">{t('artifacts.badcases.toolErrors')}</div>
                        <pre className="whitespace-pre-wrap break-all font-mono text-[10px]">{c.toolCallErrors.join('\n')}</pre>
                      </div>
                    ) : null}
                    {c.verifierReason ? (
                      <div className="mt-1">
                        <div className="text-[10px] text-muted-foreground">{t('artifacts.badcases.verifierReason')}</div>
                        <div className="text-[10px]">{c.verifierReason}</div>
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">{t('artifacts.badcases.annotate')}</span>
                        <select
                          className="rounded border border-border bg-background px-1 py-0.5 text-[11px]"
                          value={c.annotation?.label ?? ''}
                          onChange={(e) => {
                            const raw = e.target.value
                            if (LABELS.includes(raw as BadCaseLabel)) {
                              void annotate(c.instanceId, raw as BadCaseLabel)
                            }
                          }}
                          data-testid={`badcases-label-${c.instanceId}`}
                        >
                          <option value="" disabled>--</option>
                          {LABELS.map((l) => (
                            <option key={l} value={l}>{t(`artifacts.badcases.labels.${l}`)}</option>
                          ))}
                        </select>
                      </label>
                      <textarea
                        className="min-h-[24px] flex-1 rounded border border-border bg-background p-1 text-[11px]"
                        placeholder={t('artifacts.badcases.notePlaceholder')}
                        value={noteDraft[c.instanceId] ?? c.annotation?.note ?? ''}
                        onChange={(e) => setNoteDraft((prev) => ({ ...prev, [c.instanceId]: e.target.value }))}
                        aria-label={t('artifacts.badcases.note')}
                        data-testid={`badcases-note-${c.instanceId}`}
                      />
                      {savedFlash[c.instanceId] ? (
                        <span className="text-[10px] text-muted-foreground">{t('artifacts.badcases.annotationSaved')}</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </div>
  )
}
