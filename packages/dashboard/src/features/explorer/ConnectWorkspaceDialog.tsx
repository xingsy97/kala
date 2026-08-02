import { useMemo, useState } from 'react'
import { Check, Clipboard, Monitor, Terminal } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
import type { ServerSettingsPayload } from '@agent-kernel/shared'
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

const OS_TABS: ReadonlyArray<{ value: OsTab; label: string; icon: typeof Terminal }> = [
  { value: 'unix', label: 'Mac/Linux', icon: Terminal },
  { value: 'windows', label: 'Windows', icon: Monitor },
]

export function ConnectWorkspaceDialog({ open, onOpenChange }: Props): JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<OsTab>(() => detectCurrentOs())
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'pair'|'invite'>('pair')
  const [copyError, setCopyError] = useState<string | null>(null)
  const hostUrl = useMemo(() => hostUrlFromLocation(), [])
  const fallbackBootstrapBaseUrl = useMemo(() => `${hostUrl}/release-assets`, [hostUrl])

  // Executor invites are long-lived credentials managed by the host. This
  // dialog creates a fresh one so the command can show plaintext once.
  const inviteQuery = useQuery({
    queryKey: ['executor-invite'],
    queryFn: async (): Promise<{ inviteToken: string }> => {
      const res = await fetch('/auth/executor-invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error(await res.text())
      return (await res.json()) as { inviteToken: string }
    },
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  })
  const invite = inviteQuery.data ?? null
  const settingsQuery = useQuery({
    queryKey: ['settings', 'release-bootstrap'],
    queryFn: async (): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings')
      if (!res.ok) throw new Error(await res.text())
      return (await res.json()) as ServerSettingsPayload
    },
    enabled: open,
    staleTime: 30_000,
  })
  const bootstrapBaseUrl = resolveBootstrapBaseUrl(settingsQuery.data?.release, hostUrl, fallbackBootstrapBaseUrl)
  const error = inviteQuery.error ? (inviteQuery.error as Error).message : null
  const command = commandFor(tab, hostUrl, bootstrapBaseUrl, mode === 'invite' ? invite?.inviteToken : undefined)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command)
      setCopyError(null)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (error) {
      setCopied(false)
      setCopyError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-hidden p-0 gap-0" data-testid="connect-workspace-dialog">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Terminal className="h-4 w-4" aria-hidden="true" />
            {t('explorer.connectDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('explorer.connectDialog.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="px-4 py-4">
          <TerminalCommand
            tab={tab}
            command={command}
            copied={copied}
            disabled={mode === 'invite' && !invite}
            onCopy={() => void copy()}
            onTabChange={(next) => {
              setTab(next)
              setCopied(false)
              setCopyError(null)
            }}
          />
          <div className="mb-3 flex gap-2"><Button size="sm" variant={mode==='pair'?'outline':'ghost'} onClick={()=>setMode('pair')}>Approve in Dashboard</Button><Button size="sm" variant={mode==='invite'?'outline':'ghost'} onClick={()=>setMode('invite')}>Use invite</Button></div>
          <Pairings mode={mode} />
          <div className="mt-3 text-xs text-muted-foreground" role={error || copyError ? 'alert' : 'status'}>
            {error ? (
              <span className="text-destructive">
                {error}{' '}
                <button type="button" className="underline" onClick={() => { void inviteQuery.refetch() }}>{t('common.reload')}</button>
              </span>
            ) : copyError ? (
              <span className="text-destructive">{copyError}</span>
            ) : invite ? t('explorer.connectDialog.inviteReady') : t('explorer.connectDialog.preparingInvite')}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Pairings({mode}:{mode:'pair'|'invite'}):JSX.Element|null{
  const query=useQuery({queryKey:['executor-pairings'],queryFn:async()=>{const r=await fetch('/auth/executor-pairings');if(!r.ok)throw new Error(await r.text());return await r.json() as {pairings:Array<{id:string;code:string;label?:string;workspaceId:string;status:string;expiresAt:string}>}},enabled:mode==='pair',refetchInterval:2000})
  if(mode!=='pair')return null
  const pending=(query.data?.pairings??[]).filter(p=>p.status==='pending')
  return <div className="mb-3 space-y-2">{pending.map(p=><div key={p.id} className="flex items-center justify-between rounded-md border p-3"><div><div className="font-mono text-lg font-semibold tracking-widest">{p.code}</div><div className="text-xs text-muted-foreground">{p.label||p.workspaceId}</div></div><div className="flex gap-2"><Button size="sm" onClick={()=>void decide(p.id,'approve',query.refetch)}>Approve</Button><Button size="sm" variant="outline" onClick={()=>void decide(p.id,'reject',query.refetch)}>Reject</Button></div></div>)}</div>
}
async function decide(id:string,action:'approve'|'reject',refresh:()=>unknown){const r=await fetch(`/auth/executor-pairings/${encodeURIComponent(id)}/${action}`,{method:'POST'});if(!r.ok)throw new Error(await r.text());await refresh()}

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
  const { t } = useTranslation()
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
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
      <div className="bg-[#101216] px-4 py-4 font-mono text-[12px] leading-6 text-zinc-100">
        <pre className="min-w-0 select-all whitespace-pre-wrap break-words">{command || t('explorer.connectDialog.preparingInvite')}</pre>
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

function commandFor(tab: OsTab, hostUrl: string, bootstrapBaseUrl: string, invite?: string): string {
  const invitePart = invite ?? ''
  const base = bootstrapBaseUrl.replace(/\/+$/, '')
  if (tab === 'windows') {
    const quotedHost = powershellQuote(hostUrl)
    const quotedInvite = powershellQuote(invitePart)
    const query=invitePart?`?invite=${encodeURIComponent(invitePart)}`:''
    return `iex (irm ${powershellQuote(`${hostUrl}/install.ps1${query}`)})`
    return [
      `$dir = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "agent-kernel-$([guid]::NewGuid())");`,
      `iwr ${powershellQuote(`${base}/agent-kernel-executor.cjs`)} -OutFile "$dir/agent-kernel-executor.cjs";`,
      `iwr ${powershellQuote(`${base}/SHA256SUMS`)} -OutFile "$dir/SHA256SUMS";`,
      `$exp = (Get-Content "$dir/SHA256SUMS" | Where-Object { $_ -match 'agent-kernel-executor.cjs$' }).Split()[0];`,
      `if ((Get-FileHash "$dir/agent-kernel-executor.cjs" -Algorithm SHA256).Hash -ne $exp.ToUpper()) { throw 'checksum mismatch' };`,
      `$env:HOST_URL=${quotedHost};`,
      `$env:EXECUTOR_INVITE=${quotedInvite};`,
      `$env:SANDBOX_ROOTS=$env:USERPROFILE;`,
      `node "$dir/agent-kernel-executor.cjs"`,
    ].join('\n')
  }
  return `curl -fsSL ${shellQuote(`${hostUrl}/install${invitePart?`?invite=${encodeURIComponent(invitePart)}`:''}`)} | sh`
}

function resolveBootstrapBaseUrl(
  release: ServerSettingsPayload['release'] | undefined,
  hostUrl: string,
  fallback: string,
): string {
  if (!release) return fallback
  if (release.source !== 'local') return release.bootstrapBaseUrl
  const path = localReleaseAssetPath(release.bootstrapBaseUrl)
  return `${hostUrl}${path}`
}

function localReleaseAssetPath(value: string): string {
  try {
    const parsed = new URL(value)
    return parsed.pathname || '/release-assets'
  } catch {
    return value.startsWith('/') ? value : '/release-assets'
  }
}

function detectCurrentOs(): OsTab {
  const userAgentData = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = userAgentData.userAgentData?.platform ?? navigator.platform ?? ''
  const normalized = platform.toLowerCase()
  if (normalized.includes('win')) return 'windows'
  return 'unix'
}
