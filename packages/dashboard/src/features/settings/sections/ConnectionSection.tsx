import { useEffect, useState } from 'react'

import { Button } from '../../../components/ui/button.js'
import { getStoredHostEndpoint, resolveHostEndpoint, setStoredHostEndpoint } from '../../../host-endpoint.js'
import { SectionHeader } from '../controls.js'

export function ConnectionSection(): JSX.Element {
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
    query: 'URL ?host= param (temporary override)',
    settings: 'Saved in this browser',
    build: 'Baked in at build time (VITE_AGENT_KERNEL_HOST)',
    default: 'Same origin (default)',
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
      setTestState({ kind: 'ok', msg: 'reachable' })
    } catch (err) {
      setTestState({ kind: 'error', msg: err instanceof Error ? err.message : 'unreachable' })
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="Host endpoint" subtitle="Where this dashboard connects for Socket.IO, models, and settings." />

      <div className="space-y-3 rounded-md bg-card/60 p-4 text-sm ring-1 ring-border/50">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Currently used</div>
          <div className="mt-1 break-all font-mono">{current.url || '(none)'}</div>
          <div className="mt-1 text-xs text-muted-foreground">Source: {sourceLabel[current.source]}</div>
        </div>
        <div className="text-xs text-muted-foreground">
          Priority: URL ?host= &gt; saved in browser &gt; build-time env &gt; same origin.
        </div>
      </div>

      <div className="space-y-3">
        <label className="block text-sm font-medium">Override host endpoint</label>
        <input
          type="url"
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={window.location.origin}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="text-xs text-muted-foreground">
          Leave empty to fall back to the default. Cross-origin endpoints require the host to set
          {' '}<code className="rounded bg-muted px-1">AGENT_KERNEL_ALLOWED_ORIGINS</code>.
        </div>
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <Button size="sm" className="w-full sm:w-auto" onClick={save}>Save</Button>
          <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => void test()} disabled={testState.kind === 'testing'}>
            {testState.kind === 'testing' ? 'Testing…' : 'Test connection'}
          </Button>
          <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={reset}>Reset to default</Button>
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
