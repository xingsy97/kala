import { useEffect, useMemo, useState } from 'react'
import { Check, Clipboard, Monitor, Terminal } from 'lucide-react'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
}

type OsTab = 'unix' | 'windows'

const RELEASE_BASE = 'https://github.com/OWNER/REPO/releases/latest/download'
const OS_TABS: ReadonlyArray<{ value: OsTab; label: string; icon: typeof Terminal }> = [
  { value: 'unix', label: 'Mac/Linux', icon: Terminal },
  { value: 'windows', label: 'Windows', icon: Monitor },
]

export function ConnectWorkspaceDialog({ open, onOpenChange }: Props): JSX.Element {
  const [tab, setTab] = useState<OsTab>(() => detectCurrentOs())
  const [copied, setCopied] = useState(false)
  const [invite, setInvite] = useState<{ inviteToken: string; expiresAt: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hostUrl = useMemo(() => hostUrlFromLocation(), [])
  const command = commandFor(tab, hostUrl, invite?.inviteToken)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setInvite(null)
    void fetch('/auth/executor-invites', { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text())
        return res.json() as Promise<{ inviteToken: string; expiresAt: string }>
      })
      .then((body) => {
        if (!cancelled) setInvite(body)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-hidden p-0 gap-0" data-testid="connect-workspace-dialog">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Terminal className="h-4 w-4" aria-hidden="true" />
            Connect workspace
          </DialogTitle>
          <DialogDescription>
            Run one command in the project directory on the machine that should execute tools.
          </DialogDescription>
        </DialogHeader>
        <div className="px-4 py-4">
          <TerminalCommand
            tab={tab}
            command={command}
            copied={copied}
            disabled={!invite}
            onCopy={() => void copy()}
            onTabChange={(next) => {
              setTab(next)
              setCopied(false)
            }}
          />
          <div className="mt-3 text-xs text-muted-foreground">
            {error ? <span className="text-destructive">{error}</span> : invite ? `Invite expires at ${new Date(invite.expiresAt).toLocaleTimeString()}` : 'Preparing one-time invite...'}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TerminalCommand({
  tab,
  command,
  copied,
  disabled,
  onCopy,
  onTabChange,
}: {
  tab: OsTab
  command: string
  copied: boolean
  disabled: boolean
  onCopy(): void
  onTabChange(tab: OsTab): void
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-md bg-[#101216] shadow-xl ring-1 ring-black/30 dark:ring-white/10" data-testid="executor-terminal-command">
      <div className="flex h-9 items-center gap-3 border-b border-white/10 bg-[#23252b] px-3">
        <div className="flex flex-none items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="min-w-0 flex-1" />
        <div className="inline-flex flex-none rounded bg-black/20 p-0.5" data-testid="connect-workspace-os-tabs">
          {OS_TABS.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => onTabChange(item.value)}
                className={
                  item.value === tab
                    ? 'inline-flex items-center gap-1.5 rounded bg-white/14 px-2.5 py-0.5 text-[11px] font-medium text-white shadow-sm'
                    : 'inline-flex items-center gap-1.5 rounded px-2.5 py-0.5 text-[11px] font-medium text-zinc-400 hover:bg-white/8 hover:text-zinc-100'
                }
                data-testid={`connect-workspace-tab-${item.value}`}
                aria-pressed={item.value === tab}
              >
                <Icon className="h-3 w-3" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 flex-none gap-1 px-2 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-white"
          onClick={onCopy}
          disabled={disabled}
          data-testid="copy-executor-command"
        >
          {copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="bg-[#101216] px-4 py-4 font-mono text-[12px] leading-6 text-zinc-100">
        <div className="flex min-w-0 gap-2">
          <span className="flex-none text-emerald-400">$</span>
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words">{command}</pre>
        </div>
      </div>
    </section>
  )
}

function hostUrlFromLocation(): string {
  const { protocol, hostname, port } = window.location
  const hostProtocol = protocol === 'https:' ? 'https:' : 'http:'
  return `${hostProtocol}//${hostname}${port ? `:${port}` : ''}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function powershellQuote(value: string): string {
  // PowerShell double-quoted strings interpolate `$`, treat `` ` `` as escape,
  // and end at `"`. Escape all three so an untrusted hostUrl can't break out.
  const escaped = value.replaceAll('`', '``').replaceAll('$', '`$').replaceAll('"', '`"')
  return `"${escaped}"`
}

function commandFor(tab: OsTab, hostUrl: string, invite?: string): string {
  const invitePart = invite ? invite : 'preparing-invite'
  if (tab === 'windows') {
    const quotedHost = powershellQuote(hostUrl)
    const quotedInvite = powershellQuote(invitePart)
    return [
      `$dir = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "agent-kernel-$([guid]::NewGuid())");`,
      `iwr ${RELEASE_BASE}/agent-kernel-executor.cjs -OutFile "$dir/agent-kernel-executor.cjs";`,
      `iwr ${RELEASE_BASE}/SHA256SUMS -OutFile "$dir/SHA256SUMS";`,
      `$exp = (Get-Content "$dir/SHA256SUMS" | Where-Object { $_ -match 'agent-kernel-executor.cjs$' }).Split()[0];`,
      `if ((Get-FileHash "$dir/agent-kernel-executor.cjs" -Algorithm SHA256).Hash -ne $exp.ToUpper()) { throw 'checksum mismatch' };`,
      `$env:HOST_URL=${quotedHost};`,
      `$env:EXECUTOR_INVITE=${quotedInvite};`,
      `$env:SANDBOX_ROOTS=(Get-Location).Path;`,
      `node "$dir/agent-kernel-executor.cjs"`,
    ].join('\n')
  }
  return `wget -qO- ${RELEASE_BASE}/run.sh | COMPONENT=executor HOST_URL=${shellQuote(hostUrl)} EXECUTOR_INVITE=${shellQuote(invitePart)} SANDBOX_ROOTS="$PWD" bash`
}

function detectCurrentOs(): OsTab {
  const userAgentData = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = userAgentData.userAgentData?.platform ?? navigator.platform ?? ''
  const normalized = platform.toLowerCase()
  if (normalized.includes('win')) return 'windows'
  return 'unix'
}
