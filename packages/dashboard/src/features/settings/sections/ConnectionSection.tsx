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
    <div className="space-y-6">
      <SectionHeader title={t('settings.connection.title')} subtitle={t('settings.connection.subtitle')} />

      <div className="space-y-3 rounded-md bg-card/60 p-4 text-sm ring-1 ring-border/50">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{t('settings.connection.current')}</div>
          <div className="mt-1 break-all font-mono">{current.url || t('settings.connection.none')}</div>
          <div className="mt-1 text-xs text-muted-foreground">{t('settings.connection.source', { source: sourceLabel[current.source] })}</div>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('settings.connection.priority')}
        </div>
      </div>

      <div className="space-y-3">
        <label className="block text-sm font-medium">{t('settings.connection.override')}</label>
        <input
          type="url"
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={window.location.origin}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="text-xs text-muted-foreground">
          {t('settings.connection.crossOriginPrefix')}
          {' '}<code className="rounded bg-muted px-1">AGENT_KERNEL_ALLOWED_ORIGINS</code>.
        </div>
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <Button size="sm" className="w-full sm:w-auto" onClick={save}>{t('common.save')}</Button>
          <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => void test()} disabled={testState.kind === 'testing'}>
            {testState.kind === 'testing' ? t('settings.connection.testing') : t('settings.connection.test')}
          </Button>
          <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={reset}>{t('settings.connection.reset')}</Button>
        </div>
        {testState.kind === 'ok' && (
          <div className="text-xs text-emerald-500">✓ {testState.msg}</div>
        )}
        {testState.kind === 'error' && (
          <div className="text-xs text-red-500">✗ {testState.msg}</div>
        )}
      </div>
    </div>
  )
}
