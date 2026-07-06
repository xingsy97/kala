import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
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

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
}

type SectionKey = 'runtime' | 'models' | 'approvals' | 'hooks' | 'mcp'

const SECTIONS: readonly { key: SectionKey; label: string; hint: string }[] = [
  { key: 'runtime', label: 'Runtime', hint: 'Host paths and sessions' },
  { key: 'models', label: 'Models', hint: 'Providers and default' },
  { key: 'approvals', label: 'Approvals', hint: 'Per-session, not global' },
  { key: 'hooks', label: 'Hooks', hint: 'Fire on tool events' },
  { key: 'mcp', label: 'MCP servers', hint: 'Placeholder  -  not wired yet' },
]

export function SettingsDialog({ open, onOpenChange }: Props): JSX.Element {
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
        className="max-w-4xl h-[80vh] overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)]"
        data-testid="settings-dialog"
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Read-only view of the host's runtime config. Edit the underlying files and restart the host to change these values.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-[200px_minmax(0,1fr)]">
          <aside className="min-h-0 border-r border-border bg-muted/60">
            <nav className="space-y-1 p-2" aria-label="Settings sections">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSection(s.key)}
                  data-testid={`settings-tab-${s.key}`}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                    section === s.key
                      ? 'bg-primary/10 text-foreground shadow-inner ring-1 ring-primary/30'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <div className="font-medium">{s.label}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{s.hint}</div>
                </button>
              ))}
            </nav>
          </aside>
          <ScrollArea className="min-h-0">
            <div className="p-6">
              {loadError ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  Failed to load settings: {loadError}
                </div>
              ) : payload === null ? (
                <div className="text-sm text-muted-foreground">Loading - </div>
              ) : section === 'runtime' ? (
                <RuntimeSection payload={payload} />
              ) : section === 'models' ? (
                <ModelsSection payload={payload} />
              ) : section === 'approvals' ? (
                <ApprovalsSection />
              ) : section === 'hooks' ? (
                <HooksSection payload={payload} />
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
                  'border-border',
                  i !== rows.length - 1 && 'border-b',
                )}
              >
                <th className="w-56 border-r border-border bg-muted/50 px-3 py-2.5 text-left font-medium">
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
}: {
  payload: ServerSettingsPayload
}): JSX.Element {
  return (
    <div>
      <SectionHeader
        title="Models"
        subtitle="Providers currently advertised by the host. API keys stay in-memory on the host and never appear here."
      />
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
              className="rounded-md border border-border p-4"
              data-testid={`settings-provider-${p.id}`}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-mono">{p.wire}</span>
                    {p.baseUrl ? (
                      <>
                        {'  -  '}
                        <span className="font-mono">{p.baseUrl}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                {p.models.some((m) => m === payload.defaultModel) ? (
                  <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">
                    default provider
                  </span>
                ) : null}
              </div>
              {p.models.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No model attached  -  set one under this provider.
                </div>
              ) : (
                <ul className="space-y-1">
                  {p.models.map((m) => (
                    <li
                      key={m}
                      className="flex items-center justify-between gap-2 rounded border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs"
                    >
                      <span>{m}</span>
                      {m === payload.defaultModel ? (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-primary">
                          default
                        </span>
                      ) : null}
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

function ApprovalsSection(): JSX.Element {
  return (
    <div>
      <SectionHeader
        title="Approvals"
        subtitle="Approval mode is per-session, controlled from the composer. There is no global default here."
      />
      <ul className="space-y-2 text-sm">
        <li>
          <b>Auto</b>  -  non-destructive tools run immediately; destructive tools ask.
        </li>
        <li>
          <b>Ask everything</b>  -  every tool call waits for approval.
        </li>
        <li>
          <b>Deny</b>  -  every approval-requiring tool call fails without dispatching. Used for replay/demo.
        </li>
        <li>
          <b>Allow all</b>  -  bypass approval for every tool call, including destructive ones. Only permitted when the host was launched with{' '}
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
        subtitle="Commands the host runs around session and tool events. Configured in the hooks TOML file  -  non-zero exit from a pre_tool_use hook blocks the call."
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
                <th className="border-b border-border px-3 py-2 text-left">Event</th>
                <th className="border-b border-border px-3 py-2 text-left">Match</th>
                <th className="border-b border-border px-3 py-2 text-left">Command</th>
              </tr>
            </thead>
            <tbody>
              {payload.hooks.map((h, i) => (
                <tr
                  key={i}
                  className={cn(
                    'border-border',
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
        The design is fixed (executor-side spawning, <code className="font-mono">&lt;server&gt;__&lt;tool&gt;</code> naming, approvals inherit the session's mode). Implementation is deferred  -  the ecosystem overlap with the builtin tool set is small. See{' '}
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
      // Non-fatal  -  clipboard permission denied.
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
