import { useEffect, useState, type FormEvent } from 'react'
import { Check, Copy, ExternalLink, Plus, Trash2 } from 'lucide-react'
import type { ServerSettingsPayload } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import { PREF_SHOW_TOOL_CALL_TAB, useBooleanPref } from '../../lib/prefs.js'
import {
  DESKTOP_NOTIFICATION_PREFS,
  PREF_DESKTOP_NOTIFICATIONS_ENABLED,
  PREF_DESKTOP_NOTIFICATION_SOUND,
  notificationPermission,
  requestNotificationPermission,
} from '../../lib/desktop-notifications.js'

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  onModelsChanged?(): void
}

type SectionKey = 'runtime' | 'models' | 'approvals' | 'hooks' | 'mcp' | 'interface'

const SECTIONS: readonly { key: SectionKey; label: string; hint: string }[] = [
  { key: 'runtime', label: 'Runtime', hint: 'Host paths and sessions' },
  { key: 'models', label: 'Models', hint: 'Providers and default' },
  { key: 'approvals', label: 'Approvals', hint: 'Per-session, not global' },
  { key: 'hooks', label: 'Hooks', hint: 'Fire on tool events' },
  { key: 'interface', label: 'Interface', hint: 'Dashboard UI toggles' },
  { key: 'mcp', label: 'MCP servers', hint: 'Placeholder — not wired yet' },
]

export function SettingsDialog({ open, onOpenChange, onModelsChanged }: Props): JSX.Element {
  const [payload, setPayload] = useState<ServerSettingsPayload | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [section, setSection] = useState<SectionKey>('runtime')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadError(null)
    void fetch('/settings', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<ServerSettingsPayload>
      })
      .then((body) => {
        if (cancelled) return
        setPayload(body)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(90dvh,44rem)] max-w-4xl overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)]"
        data-testid="settings-dialog"
      >
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Runtime config, provider sources, hooks, and manually managed model ids.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[200px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="min-h-0 border-b border-border/50 bg-muted/60 md:border-b-0 md:border-r">
            <ScrollArea className="h-full">
              <nav className="flex gap-1 p-2 md:block md:space-y-1" aria-label="Settings sections">
                {SECTIONS.map((s) => (
                  <SettingsSectionButton key={s.key} section={s} active={section === s.key} onClick={() => setSection(s.key)} />
                ))}
              </nav>
            </ScrollArea>
          </aside>
          <ScrollArea className="min-h-0">
            <div className="p-4 sm:p-6">
              {loadError ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  Failed to load settings: {loadError}
                </div>
              ) : payload === null ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : section === 'runtime' ? (
                <RuntimeSection payload={payload} />
              ) : section === 'models' ? (
                <ModelsSection payload={payload} onPayloadChange={setPayload} onModelsChanged={onModelsChanged} />
              ) : section === 'approvals' ? (
                <ApprovalsSection />
              ) : section === 'hooks' ? (
                <HooksSection payload={payload} />
              ) : section === 'interface' ? (
                <InterfaceSection />
              ) : (
                <McpSection payload={payload} />
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SettingsSectionButton({
  section,
  active,
  onClick,
}: {
  section: (typeof SECTIONS)[number]
  active: boolean
  onClick(): void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`settings-tab-${section.key}`}
      className={cn(
        'w-36 flex-none rounded-md px-3 py-2 text-left text-sm transition-colors md:w-full',
        active
          ? 'bg-primary/10 text-foreground shadow-inner ring-1 ring-primary/30'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <div className="font-medium">{section.label}</div>
      <div className="mt-0.5 hidden text-[11px] text-muted-foreground md:block">{section.hint}</div>
    </button>
  )
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}): JSX.Element {
  return (
    <div className="mb-4">
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {subtitle ? (
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function RuntimeSection({
  payload,
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  const rows: Array<[string, string]> = [
    ['Anthropic settings', payload.paths.claudeSettings],
    ['OpenAI-compatible providers', payload.paths.codexConfig],
    ['Manual models', payload.paths.manualModels],
    ['Hooks config', payload.paths.hooksConfig],
    ['Sessions directory', payload.paths.sessionsDir],
  ]
  return (
    <div>
      <SectionHeader
        title="Runtime"
        subtitle="Configuration files the host reads on startup. Edit these, then restart the host process."
      />
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([label, path], i) => (
              <tr
                key={label}
                className={cn(
                  'border-border/50',
                  i !== rows.length - 1 && 'border-b',
                )}
              >
                <th className="w-56 border-r border-border/50 bg-muted/50 px-3 py-2.5 text-left font-medium">
                  {label}
                </th>
                <td className="px-3 py-2.5 font-mono text-xs">
                  <div className="flex items-center gap-2">
                    <span className="truncate" title={path}>{path}</span>
                    <CopyButton value={path} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ModelsSection({
  payload,
  onPayloadChange,
  onModelsChanged,
}: {
  payload: ServerSettingsPayload
  onPayloadChange(payload: ServerSettingsPayload): void
  onModelsChanged?(): void
}): JSX.Element {
  const [providerId, setProviderId] = useState(payload.providers[0]?.id ?? '')
  const [modelId, setModelId] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!payload.providers.some((p) => p.id === providerId)) {
      setProviderId(payload.providers[0]?.id ?? '')
    }
  }, [payload.providers, providerId])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/settings/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId, id: modelId.trim(), label: label.trim() || undefined }),
      })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      onPayloadChange(body as ServerSettingsPayload)
      onModelsChanged?.()
      setModelId('')
      setLabel('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const deleteManual = async (deleteProviderId: string, id: string): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const params = new URLSearchParams({ providerId: deleteProviderId, id })
      const res = await fetch(`/settings/models?${params.toString()}`, { method: 'DELETE' })
      const body = await res.json() as ServerSettingsPayload | { error?: string }
      if (!res.ok) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`)
      onPayloadChange(body as ServerSettingsPayload)
      onModelsChanged?.()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <SectionHeader
        title="Models"
        subtitle="Models advertised by the host. Auto-discovered entries are read-only; manual entries bind a model id to an existing provider endpoint."
      />
      <form onSubmit={(event) => { void submit(event) }} className="mb-4 rounded-md border border-border bg-muted/30 p-3">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="text-xs font-medium text-muted-foreground">
            Provider
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              disabled={payload.providers.length === 0 || busy}
              data-testid="settings-model-provider-select"
            >
              {payload.providers.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Model id
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="gpt-5.5-mini"
              disabled={payload.providers.length === 0 || busy}
              data-testid="settings-model-id-input"
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            Label
            <input
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="optional"
              disabled={payload.providers.length === 0 || busy}
            />
          </label>
          <Button type="submit" className="mt-5 h-9" disabled={payload.providers.length === 0 || busy || modelId.trim().length === 0}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> Add
          </Button>
        </div>
        {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
        <div className="mt-2 text-xs text-muted-foreground">
          Manual models are stored at <code className="font-mono">{payload.paths.manualModels}</code> and never contain API keys.
        </div>
      </form>
      {payload.providers.length === 0 ? (
        <EmptyRow>
          No provider is configured. Add one in{' '}
          <code className="font-mono">{payload.paths.claudeSettings}</code> or{' '}
          <code className="font-mono">{payload.paths.codexConfig}</code>.
        </EmptyRow>
      ) : (
        <div className="space-y-4">
          {payload.providers.map((p) => (
            <div
              key={p.id}
              className="rounded-md border border-border bg-card/60 p-4"
              data-testid={`settings-provider-${p.id}`}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-mono">{p.wire}</span>
                    {' · '}
                    <SourceBadge source={p.source ?? 'unknown'} />
                    {p.baseUrl ? (
                      <>
                        {' · '}
                        <span className="font-mono">{p.baseUrl}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                {p.models.some((m) => m.id === payload.defaultModel) ? (
                  <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">
                    default provider
                  </span>
                ) : null}
              </div>
              {p.models.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No model attached — set one under this provider.
                </div>
              ) : (
                <ul className="space-y-1">
                  {p.models.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded border border-border bg-muted/40 px-2.5 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate font-mono">{m.id}</span>
                      <span className="flex flex-none items-center gap-2">
                        <SourceBadge source={m.source ?? p.source ?? 'unknown'} />
                        {m.id === payload.defaultModel ? (
                          <span className="text-[10px] font-medium uppercase tracking-wide text-primary">
                            default
                          </span>
                        ) : null}
                        {m.source === 'manual' ? (
                          <button
                            type="button"
                            onClick={() => { void deleteManual(p.id, m.id) }}
                            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`delete model ${m.id}`}
                            disabled={busy}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SourceBadge({ source }: { source: string }): JSX.Element {
  const label = source === 'claude-settings'
    ? 'Claude Code'
    : source === 'codex-config'
      ? 'Codex'
      : source === 'env'
        ? 'Env'
        : source === 'manual'
          ? 'Manual'
          : 'Unknown'
  return (
    <span className="rounded border border-border bg-background/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  )
}

function ApprovalsSection(): JSX.Element {
  return (
    <div>
      <SectionHeader
        title="Approvals"
        subtitle="Approval mode is per-session, controlled from the composer. There is no global default here."
      />
      <ul className="space-y-2 text-sm">
        <li>
          <b>Auto</b> — non-destructive tools run immediately; destructive tools ask.
        </li>
        <li>
          <b>Ask everything</b> — every tool call waits for approval.
        </li>
        <li>
          <b>Deny</b> — every approval-requiring tool call fails without dispatching. Used for replay/demo.
        </li>
        <li>
          <b>Allow all</b> — bypass approval for every tool call, including destructive ones. Only permitted when the host was launched with{' '}
          <code className="font-mono">AK_ALLOW_ALL_OK=1</code>.
        </li>
      </ul>
    </div>
  )
}

function HooksSection({
  payload,
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  return (
    <div>
      <SectionHeader
        title="Hooks"
        subtitle="Commands the host runs around session and tool events. Configured in the hooks TOML file — non-zero exit from a pre_tool_use hook blocks the call."
      />
      {payload.hooks.length === 0 ? (
        <EmptyRow>
          No hooks configured. Add <code className="font-mono">[[hooks]]</code> entries to{' '}
          <code className="font-mono">{payload.paths.hooksConfig}</code> and restart the host.
        </EmptyRow>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="border-b border-border/50 px-3 py-2 text-left">Event</th>
                <th className="border-b border-border/50 px-3 py-2 text-left">Match</th>
                <th className="border-b border-border/50 px-3 py-2 text-left">Command</th>
              </tr>
            </thead>
            <tbody>
              {payload.hooks.map((h, i) => (
                <tr
                  key={i}
                  className={cn(
                    'border-border/50',
                    i !== payload.hooks.length - 1 && 'border-b',
                  )}
                >
                  <td className="px-3 py-2 font-mono text-xs">{h.event}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {h.match ?? '*'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span className="truncate" title={h.command}>{h.command}</span>
                      <CopyButton value={h.command} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Example hook config</summary>
        <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-foreground">
{`[[hooks]]
event = "pre_tool_use"
match = "bash"
command = "/usr/local/bin/lint-shell.sh"`}
        </pre>
      </details>
    </div>
  )
}

function InterfaceSection(): JSX.Element {
  const [showToolCallTab, setShowToolCallTab] = useBooleanPref(PREF_SHOW_TOOL_CALL_TAB, true)
  return (
    <div>
      <SectionHeader
        title="Interface"
        subtitle="Dashboard UI toggles. Stored per-browser in localStorage — no host restart required."
      />
      <ul className="space-y-3 text-sm">
        <li className="flex items-start justify-between gap-4 rounded-md border border-border bg-card/60 px-4 py-3">
          <div className="min-w-0">
            <div className="font-medium">Show Tool Call tab in Inspector</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Adds a dedicated "Tool Call" tab beside Trace / LLM API / Status. When off, tool calls still appear inside the Trace view — use the Trace filter chips to isolate them.
            </p>
          </div>
          <Toggle
            checked={showToolCallTab}
            onChange={setShowToolCallTab}
            ariaLabel="Show Tool Call tab in Inspector"
            testId="settings-toggle-tool-call-tab"
          />
        </li>
        <DesktopNotificationsSettings />
      </ul>
    </div>
  )
}

function DesktopNotificationsSettings(): JSX.Element {
  const [enabled, setEnabled] = useBooleanPref(PREF_DESKTOP_NOTIFICATIONS_ENABLED, false)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => notificationPermission())
  const [busy, setBusy] = useState(false)

  const setDesktopNotifications = async (next: boolean): Promise<void> => {
    if (!next) {
      setEnabled(false)
      return
    }
    const current = notificationPermission()
    if (current === 'granted') {
      setPermission(current)
      setEnabled(true)
      return
    }
    if (current === 'denied' || current === 'unsupported') {
      setPermission(current)
      setEnabled(false)
      return
    }
    setBusy(true)
    try {
      const result = await requestNotificationPermission()
      setPermission(result)
      setEnabled(result === 'granted')
    } finally {
      setBusy(false)
    }
  }

  const unavailable = permission === 'denied' || permission === 'unsupported'
  return (
    <li className="rounded-md border border-border bg-card/60 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium">Desktop notifications</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Notify when the active session needs user intervention. Browser permission is required.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground" data-testid="desktop-notification-permission">
            Permission: {permissionLabel(permission)}
          </p>
        </div>
        <Toggle
          checked={enabled && permission === 'granted'}
          onChange={(next) => { void setDesktopNotifications(next) }}
          ariaLabel="Enable desktop notifications"
          testId="settings-toggle-desktop-notifications"
          disabled={busy || unavailable}
        />
      </div>
      {unavailable ? (
        <div className="mt-3 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {permission === 'unsupported'
            ? 'This browser does not support desktop notifications.'
            : 'Notifications are blocked in the browser. Re-enable them from site settings.'}
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 border-t border-border/50 pt-3">
        <NotificationKindToggle
          prefKey={PREF_DESKTOP_NOTIFICATION_SOUND}
          label="Sound"
          description="Play a short local sound when a desktop notification is sent."
          disabled={!enabled || permission !== 'granted'}
        />
        {DESKTOP_NOTIFICATION_PREFS.map((pref) => (
          <NotificationKindToggle key={pref.kind} prefKey={pref.key} label={pref.label} description={pref.description} disabled={!enabled || permission !== 'granted'} />
        ))}
      </div>
    </li>
  )
}

function NotificationKindToggle({
  prefKey,
  label,
  description,
  disabled,
}: {
  prefKey: string
  label: string
  description: string
  disabled: boolean
}): JSX.Element {
  const [checked, setChecked] = useBooleanPref(prefKey, true)
  return (
    <div className="flex items-center justify-between gap-4 rounded-md bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
      <Toggle
        checked={checked}
        onChange={setChecked}
        ariaLabel={`Notify: ${label}`}
        testId={`settings-toggle-notification-${prefKey}`}
        disabled={disabled}
      />
    </div>
  )
}

function permissionLabel(permission: NotificationPermission | 'unsupported'): string {
  if (permission === 'default') return 'not requested'
  if (permission === 'unsupported') return 'unsupported'
  return permission
}

function Toggle({
  checked,
  onChange,
  ariaLabel,
  testId,
  disabled = false,
}: {
  checked: boolean
  onChange(next: boolean): void
  ariaLabel: string
  testId?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

function McpSection({
  payload,
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  return (
    <div>
      <SectionHeader
        title="MCP servers"
        subtitle="Model Context Protocol integration for external tool servers."
      />
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <div className="mb-1 font-medium text-foreground">Not implemented yet</div>
        <p className="text-muted-foreground">{payload.mcp.note}</p>
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        The design is fixed (executor-side spawning, <code className="font-mono">&lt;server&gt;__&lt;tool&gt;</code> naming, approvals inherit the session's mode). Implementation is deferred — the ecosystem overlap with the builtin tool set is small. See{' '}
        <code className="font-mono">docs/mcp.md</code> in the repo for the full spec.
      </p>
      <div className="mt-4 flex items-center gap-2 text-sm">
        <a
          href="https://modelcontextprotocol.io"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          Model Context Protocol
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function CopyButton({ value }: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // Non-fatal — clipboard permission denied.
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-6 w-6 flex-none text-muted-foreground hover:text-foreground"
      aria-label={copied ? 'copied' : 'copy value'}
      onClick={() => {
        void copy()
      }}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  )
}
