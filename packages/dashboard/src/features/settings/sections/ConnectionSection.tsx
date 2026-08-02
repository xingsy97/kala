import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui/button.js'
import { getStoredHostEndpoint, resolveHostEndpoint, setStoredHostEndpoint } from '../../../host-endpoint.js'
import { SectionHeader } from '../controls.js'

export function ConnectionSection(): JSX.Element {
  const { t } = useTranslation()
  const [current, setCurrent] = useState(() => resolveHostEndpoint())
  const [draft, setDraft] = useState<string>(() => getStoredHostEndpoint() ?? '')
  const [testState, setTestState] = useState<{ kind: 'idle' | 'testing' | 'ok' | 'error'; msg?: string }>({ kind: 'idle' })

  useEffect(() => {
    const refresh = () => setCurrent(resolveHostEndpoint())
    window.addEventListener('agent-kernel:host-endpoint-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('agent-kernel:host-endpoint-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const sourceLabel: Record<typeof current.source, string> = {
    query: t('settings.connection.sources.query'),
    settings: t('settings.connection.sources.settings'),
    build: t('settings.connection.sources.build'),
    default: t('settings.connection.sources.default'),
  }

  const save = () => {
    setStoredHostEndpoint(draft.trim() === '' ? null : draft.trim())
    setTestState({ kind: 'idle' })
  }
  const reset = () => {
    setStoredHostEndpoint(null)
    setDraft('')
    setTestState({ kind: 'idle' })
  }
  const test = async () => {
    const target = draft.trim() === '' ? window.location.origin : draft.trim().replace(/\/+$/, '')
    setTestState({ kind: 'testing' })
    try {
      const res = await fetch(`${target}/models`, { method: 'GET' })
      if (!res.ok) {
        setTestState({ kind: 'error', msg: `HTTP ${res.status}` })
        return
      }
      setTestState({ kind: 'ok', msg: t('settings.connection.reachable') })
    } catch (err) {
      setTestState({ kind: 'error', msg: err instanceof Error ? err.message : t('settings.connection.unreachable') })
    }
  }

  return (
    <div className="space-y-5 md:space-y-6">
      <SectionHeader title={t('settings.connection.title')} subtitle={t('settings.connection.subtitle')} />

      <div className="space-y-2.5 rounded-xl bg-card/60 p-4 text-sm ring-1 ring-border/50 md:space-y-3 md:rounded-md">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{t('settings.connection.current')}</div>
          <div className="mt-1 break-all font-mono">{current.url || t('settings.connection.none')}</div>
          <div className="mt-1 text-xs text-muted-foreground">{t('settings.connection.source', { source: sourceLabel[current.source] })}</div>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('settings.connection.priority')}
        </div>
      </div>

      <div className="space-y-3 rounded-xl bg-card/30 p-4 ring-1 ring-border/40 md:rounded-none md:bg-transparent md:p-0 md:ring-0">
        <label className="block text-sm font-medium">{t('settings.connection.override')}</label>
        <input
          type="url"
          data-testid="settings-connection-endpoint"
          className="h-11 w-full rounded-lg border border-input bg-background px-3 font-mono text-base outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring md:h-auto md:rounded-md md:py-2 md:text-sm"
          placeholder={window.location.origin}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="text-xs text-muted-foreground">
          {t('settings.connection.crossOriginPrefix')}
          {' '}<code className="rounded bg-muted px-1">AGENT_KERNEL_ALLOWED_ORIGINS</code>.
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button data-testid="settings-connection-save" className="h-10 rounded-lg px-5 md:h-7 md:rounded md:px-2" onClick={save}>{t('common.save')}</Button>
          <Button data-testid="settings-connection-test" variant="outline" className="h-10 rounded-lg px-4 md:h-7 md:rounded md:px-2" onClick={() => void test()} disabled={testState.kind === 'testing'}>
            {testState.kind === 'testing' ? t('settings.connection.testing') : t('settings.connection.test')}
          </Button>
          <Button data-testid="settings-connection-reset" variant="ghost" className="ml-auto h-10 rounded-lg px-3 text-muted-foreground md:ml-0 md:h-7 md:rounded md:px-2" onClick={reset}>{t('settings.connection.reset')}</Button>
        </div>
        {testState.kind === 'ok' && (
          <div className="text-xs text-emerald-500" data-testid="settings-connection-result">✓ {testState.msg}</div>
        )}
        {testState.kind === 'error' && (
          <div className="text-xs text-red-500" data-testid="settings-connection-result" role="alert">✗ {testState.msg}</div>
        )}
      </div>
    </div>
  )
}
