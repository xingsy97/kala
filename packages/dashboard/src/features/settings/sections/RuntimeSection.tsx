import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { CopyButton, SectionHeader, SettingsKeyValueList } from '../controls.js'
import { errorMessageFromBody } from '../section-utils.js'

export function RuntimeSection({
  payload,
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [operation, setOperation] = useState<{ operationId: string; deploymentId?: string; phase: string; blockers?: readonly string[] } | null>(null)
  const platform = payload.deployment?.deployment.architecture === 'platform'
  const restart = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const res = await fetch(platform ? '/runtime/deployment/restart' : '/runtime/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(platform ? {} : { mode: 'checkpoint', reason: 'manual' }),
      })
      const body = await res.json() as unknown | { error?: string }
      if (!res.ok) throw new Error(errorMessageFromBody(body) ?? `HTTP ${res.status}`)
      return body
    },
    onSuccess: (body) => {
      setError(null)
      if (platform) setOperation(body as { operationId: string; deploymentId?: string; phase: string })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  const abortRestart = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const res = await fetch(platform && operation ? `/runtime/deployment/operations/${encodeURIComponent(operation.operationId)}/abort` : '/runtime/restart/abort', { method: 'POST' })
      const body = await res.json() as unknown
      if (!res.ok) throw new Error(errorMessageFromBody(body) ?? `HTTP ${res.status}`)
      return body
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  useEffect(() => {
    if (!platform || !operation || ['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed', 'rejected'].includes(operation.phase)) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`/runtime/deployment/operations/${encodeURIComponent(operation.operationId)}`, { cache: 'no-store' })
        const body = await res.json() as { operationId?: string; deploymentId?: string; phase?: string; blockers?: readonly string[]; error?: { message?: string } }
        if (!res.ok || !body.phase) throw new Error(body.error?.message ?? `HTTP ${res.status}`)
        if (!cancelled) {
          setOperation((current) => current?.operationId === operation.operationId ? { ...current, ...body, operationId: operation.operationId, phase: body.phase! } : current)
          if (body.error?.message) setError(body.error.message)
        }
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 1_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [operation?.operationId, operation?.phase, platform])
  const rows: Array<[string, string]> = [
    [t('settings.runtime.anthropicSettings'), payload.paths.claudeSettings],
    [t('settings.runtime.openaiProviders'), payload.paths.codexConfig],
    [t('settings.runtime.manualModels'), payload.paths.manualModels],
    [t('settings.runtime.hooksConfig'), payload.paths.hooksConfig],
    [t('settings.runtime.sessionsDirectory'), payload.paths.sessionsDir],
  ]
  const runtime = payload.runtime
  const currentAttempt = runtime?.current
  const restartActive = platform ? Boolean(operation && !['completed', 'aborted', 'rolled_back', 'rollback_failed', 'failed', 'rejected'].includes(operation.phase)) : Boolean(currentAttempt)
  return (
    <div>
      <SectionHeader
        title={t('settings.sections.runtime.label')}
        subtitle={t('settings.runtime.subtitle')}
      />
      {runtime ? (
        <div className="mb-4 rounded-md bg-black/[0.18] p-4 ring-1 ring-white/10">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="min-w-0 space-y-1 text-sm">
              <div className="font-medium text-foreground">{t('settings.runtime.hostRuntime')}</div>
              <div className="text-xs text-muted-foreground">PID {runtime.pid} - {t('settings.runtime.startedAt')}: {runtime.startedAt}</div>
              <div className="text-xs text-muted-foreground">
                {t('settings.runtime.restartPhase')}: {platform ? operation?.phase ?? t('settings.runtime.restartIdle') : currentAttempt?.phase ?? t('settings.runtime.restartIdle')}
                {!platform && currentAttempt ? ` - ${currentAttempt.sessions.length} ${t('settings.runtime.restartSessions')}` : ''}
              </div>
              {operation?.blockers?.length ? <div className="text-xs text-amber-600">{t('settings.runtime.restartBlockers')}: {operation.blockers.join(', ')}</div> : null}
              {operation?.operationId ? <div className="break-all font-mono text-[10px] text-muted-foreground">{operation.operationId}</div> : null}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" size="sm" className="h-9" disabled={restart.isPending || restartActive} onClick={() => restart.mutate()}>
                <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.runtime.restartHost')}
              </Button>
              {restartActive ? (
                <Button type="button" variant="outline" size="sm" className="h-9" disabled={abortRestart.isPending} onClick={() => abortRestart.mutate()}>
                  {t('settings.runtime.abortRestart')}
                </Button>
              ) : null}
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('settings.runtime.restartDesc')}</p>
          {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
        </div>
      ) : null}
      <SettingsKeyValueList
        testId="settings-runtime-paths"
        rows={rows.map(([label, path]) => ({
          label,
          value: (
            <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
              <span className="min-w-0 flex-1 break-all" title={path}>{path}</span>
              <CopyButton value={path} />
            </div>
          ),
        }))}
      />
    </div>
  )
}
