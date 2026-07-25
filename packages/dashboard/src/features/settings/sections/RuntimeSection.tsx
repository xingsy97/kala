import type { ServerSettingsPayload } from '@agent-kernel/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
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
  const restart = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const res = await fetch('/runtime/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'checkpoint', reason: 'manual' }),
      })
      const body = await res.json() as unknown | { error?: string }
      if (!res.ok) throw new Error(errorMessageFromBody(body) ?? `HTTP ${res.status}`)
      return body
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  const abortRestart = useMutation({
    mutationFn: async (): Promise<unknown> => {
      const res = await fetch('/runtime/restart/abort', { method: 'POST' })
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
  const rows: Array<[string, string]> = [
    [t('settings.runtime.anthropicSettings'), payload.paths.claudeSettings],
    [t('settings.runtime.openaiProviders'), payload.paths.codexConfig],
    [t('settings.runtime.manualModels'), payload.paths.manualModels],
    [t('settings.runtime.hooksConfig'), payload.paths.hooksConfig],
    [t('settings.runtime.sessionsDirectory'), payload.paths.sessionsDir],
  ]
  const runtime = payload.runtime
  const currentAttempt = runtime?.current
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
                {t('settings.runtime.restartPhase')}: {currentAttempt?.phase ?? t('settings.runtime.restartIdle')}
                {currentAttempt ? ` - ${currentAttempt.sessions.length} ${t('settings.runtime.restartSessions')}` : ''}
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" size="sm" className="h-9" disabled={restart.isPending || Boolean(currentAttempt)} onClick={() => restart.mutate()}>
                <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t('settings.runtime.restartHost')}
              </Button>
              {currentAttempt ? (
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
