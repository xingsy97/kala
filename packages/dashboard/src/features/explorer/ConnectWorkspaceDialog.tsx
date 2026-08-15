import { useEffect, useRef, useState } from 'react'
import { Apple, Check, CheckCircle2, Clipboard, Clock3, LoaderCircle, Monitor, ShieldCheck, Terminal, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  CreateExecutorInstall,
  ExecutorInstallEvent,
  ExecutorInstallMode,
  ExecutorInstallPlatform,
  ExecutorInstallStatusSnapshot,
} from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
}

type InstallResponse = ExecutorInstallStatusSnapshot & { command?: string; setupCode?: string }
type FormState = Pick<CreateExecutorInstall, 'platform' | 'mode'>

const POLL_INTERVAL_MS = 2_000
const PATCH_DEBOUNCE_MS = 350
const PLATFORMS: ExecutorInstallPlatform[] = ['linux', 'macos', 'windows']
const MODES: ExecutorInstallMode[] = ['service', 'temporary']

export function ConnectWorkspaceDialog({ open, onOpenChange }: Props): JSX.Element {
  const { t } = useTranslation()
  const [form, setForm] = useState<FormState>(() => ({
    platform: detectCurrentPlatform(),
    mode: 'service',
  }))
  const [installation, setInstallation] = useState<InstallResponse | null>(null)
  const [command, setCommand] = useState('')
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const generationRef = useRef(0)
  const createdFormRef = useRef<FormState | null>(null)
  const installationIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open) {
      generationRef.current += 1
      // Do not delete the installation when the dialog closes. The normal flow
      // is copy command → close dialog → run it in another terminal; deleting
      // here invalidated the displayed one-time setup code before it could be
      // claimed and made every copied command fail with HTTP 401. Unclaimed
      // records are bounded by the Host TTL and expire automatically.
      installationIdRef.current = null
      setInstallation(null)
      setCommand('')
      setPairingCode(null)
      setError(null)
      setCopyError(null)
      createdFormRef.current = null
      return
    }

    const generation = ++generationRef.current
    const controller = new AbortController()
    const input = toApiInput(form)
    createdFormRef.current = form
    setError(null)
    void request<InstallResponse>('/api/executor-installs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    }).then((created) => {
      if (generationRef.current !== generation) return
      installationIdRef.current = created.id
      setInstallation(created)
      setCommand(created.command ?? '')
      updatePairingCode(created, setPairingCode)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted && generationRef.current === generation) setError(errorMessage(cause))
    })

    return () => controller.abort()
    // A session is created once per opening. Form edits are handled by the debounced PATCH effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open || !installation || !createdFormRef.current || sameForm(form, createdFormRef.current)) return
    const previousInstallationId = installation.id
    const generation = generationRef.current
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      // A setup command contains a one-time code that the Host stores only as a
      // hash. PATCH cannot regenerate that command for a new platform or mode.
      // Create a replacement first, then retire the still-unclaimed old record.
      void request<InstallResponse>('/api/executor-installs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toApiInput(form)),
        signal: controller.signal,
      }).then((created) => {
        if (generationRef.current !== generation) return
        installationIdRef.current = created.id
        createdFormRef.current = form
        setInstallation(created)
        setCommand(created.command ?? '')
        updatePairingCode(created, setPairingCode)
        setError(null)
        void fetch(`/api/executor-installs/${encodeURIComponent(previousInstallationId)}`, { method: 'DELETE' }).catch(() => {})
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted && generationRef.current === generation) setError(errorMessage(cause))
      })
    }, PATCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [form, installation, open])

  useEffect(() => {
    if (!open || !installation) return
    const installationId = installation.id
    const generation = generationRef.current
    let lastSeq = installation.seq
    let stopped = false
    let timeout: number | undefined
    let controller: AbortController | undefined

    const poll = async (): Promise<void> => {
      controller = new AbortController()
      try {
        const encodedId = encodeURIComponent(installationId)
        const [snapshot, eventResult] = await Promise.all([
          request<InstallResponse>(`/api/executor-installs/${encodedId}`, { signal: controller.signal }),
          request<{ events: ExecutorInstallEvent[] }>(`/api/executor-installs/${encodedId}/events?after=${lastSeq}`, { signal: controller.signal }),
        ])
        if (stopped || generationRef.current !== generation) return
        const events = eventResult.events ?? []
        const latestEvent = events.at(-1)
        lastSeq = Math.max(lastSeq, snapshot.seq, latestEvent?.seq ?? -1)
        const next = latestEvent && latestEvent.seq > snapshot.seq
          ? { ...snapshot, status: latestEvent.status, seq: latestEvent.seq, errorCode: latestEvent.errorCode }
          : snapshot
        setInstallation(next)
        if (snapshot.command !== undefined) setCommand(snapshot.command)
        updatePairingCode(latestEvent ?? snapshot, setPairingCode)
        setError(next.errorCode ?? null)
      } catch (cause) {
        if (!controller.signal.aborted && !stopped) setError(errorMessage(cause))
      } finally {
        if (!stopped && generationRef.current === generation) timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
      }
    }

    timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      stopped = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      controller?.abort()
    }
  }, [installation?.id, open])

  const updateForm = (patch: Partial<FormState>): void => {
    setForm((current) => {
      const next = { ...current, ...patch }
      return next
    })
    setCopied(false)
    setCopyError(null)
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command)
      setCopyError(null)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    } catch (cause) {
      setCopied(false)
      setCopyError(errorMessage(cause))
    }
  }

  const decide = async (action: 'approve' | 'reject'): Promise<void> => {
    if (!installation) return
    setDeciding(true)
    try {
      const updated = await request<InstallResponse>(`/api/executor-installs/${encodeURIComponent(installation.id)}/${action}`, { method: 'POST' })
      setInstallation(updated)
      updatePairingCode(updated, setPairingCode)
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDeciding(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(dialogMobileSheetClassName, 'grid min-w-0 max-w-4xl grid-rows-[auto_minmax(0,1fr)] border-0 bg-popover shadow-2xl sm:max-h-[min(var(--ak-viewport-h,92dvh),46rem)] sm:rounded-3xl')} data-testid="connect-workspace-dialog">
        <DialogHeader className="border-b border-border/35 px-5 pb-4 pt-5 pr-14 sm:px-7 sm:pb-5 sm:pt-6 sm:pr-16">
          <span className="mb-2 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground" aria-hidden="true">
            <Terminal className="h-3.5 w-3.5" /> Workspace setup
          </span>
          <DialogTitle className="text-xl font-semibold tracking-tight sm:text-2xl">{t('explorer.connectDialog.title')}</DialogTitle>
          <DialogDescription className="max-w-2xl text-sm leading-5">{t('explorer.connectDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto p-5 sm:p-7">
          <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)] lg:gap-8">
            <section className="min-w-0 space-y-5" aria-label="Installation options">
              <SectionLabel index="1" label={t('explorer.connectDialog.platform')} />
              <PlatformGroup label={t('explorer.connectDialog.platform')} selected={form.platform} labelFor={(value) => t(`explorer.connectDialog.platforms.${value}`)} onChange={(platform) => updateForm({ platform })} />
              <ChoiceGroup label={t('explorer.connectDialog.runMode')} values={MODES} selected={form.mode} labelFor={(value) => t(`explorer.connectDialog.modes.${value}`)} onChange={(mode) => updateForm({ mode })} />
              <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground" data-testid="connect-workspace-mode-description">{t(`explorer.connectDialog.modeDescriptions.${form.mode}`)}</p>
            </section>
            <section className="min-w-0 space-y-3 lg:border-l lg:border-border/35 lg:pl-8">
              <div className="flex items-center justify-between gap-3">
                <SectionLabel index="2" label={t('explorer.connectDialog.runCommand')} />
                <InstallStatus status={installation?.status ?? 'preparing'} label={t(`explorer.connectDialog.statuses.${installation?.status ?? 'preparing'}`)} />
              </div>
              <TerminalCommand command={command} copied={copied} onCopy={() => void copy()} />
              {pairingCode ? (
                <div className="flex min-w-0 flex-col gap-3 rounded-2xl bg-amber-500/10 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="connect-workspace-pairing">
                  <span className="flex min-w-0 items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4 flex-none text-amber-600 dark:text-amber-300" /><span className="text-muted-foreground">{t('explorer.connectDialog.installationStatus')}</span><strong className="font-mono tracking-widest text-foreground">{pairingCode}</strong></span>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={deciding} onClick={() => void decide('approve')}>{t('explorer.connectDialog.approve')}</Button>
                    <Button size="sm" variant="ghost" disabled={deciding} onClick={() => void decide('reject')}>{t('explorer.connectDialog.reject')}</Button>
                  </div>
                </div>
              ) : null}
              {error || copyError ? <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error ?? copyError}</p> : null}
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SectionLabel({ index, label }: { index: string; label: string }): JSX.Element {
  return <h3 className="flex items-center gap-2 text-sm font-medium text-foreground"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 font-mono text-[10px] text-primary">{index}</span>{label}</h3>
}

function PlatformGroup({ label, selected, labelFor, onChange }: { label: string; selected: ExecutorInstallPlatform; labelFor(value: ExecutorInstallPlatform): string; onChange(value: ExecutorInstallPlatform): void }): JSX.Element {
  const icons = { linux: <LinuxMark />, macos: <Apple className="h-5 w-5" />, windows: <Monitor className="h-5 w-5" /> }
  return <fieldset className="min-w-0"><legend className="sr-only">{label}</legend><div className="grid grid-cols-3 gap-2">{PLATFORMS.map((value) => <button key={value} type="button" aria-pressed={selected === value} data-testid={`connect-workspace-${value}`} onClick={() => onChange(value)} className={`flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-2xl px-2 text-xs font-medium transition-[background-color,color,box-shadow,transform] active:scale-[0.98] ${selected === value ? 'bg-accent text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]' : 'bg-muted/20 text-muted-foreground hover:bg-accent/55 hover:text-foreground'}`}>{icons[value]}<span className="truncate">{labelFor(value)}</span></button>)}</div></fieldset>
}

function ChoiceGroup<T extends string>({ label, values, selected, labelFor, onChange }: { label: string; values: readonly T[]; selected: T; labelFor(value: T): string; onChange(value: T): void }): JSX.Element {
  return <fieldset className="min-w-0 space-y-2.5"><legend className="text-xs font-medium text-muted-foreground">{label}</legend><div className="grid min-w-0 grid-cols-2 rounded-xl bg-muted/30 p-1">{values.map((value) => <button key={value} type="button" aria-pressed={selected === value} data-testid={`connect-workspace-${value}`} onClick={() => onChange(value)} className={`h-10 min-w-0 rounded-lg px-3 text-xs font-medium transition-colors sm:h-9 ${selected === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{labelFor(value)}</button>)}</div></fieldset>
}

function TerminalCommand({ command, copied, onCopy }: { command: string; copied: boolean; onCopy(): void }): JSX.Element {
  const { t } = useTranslation()
  if (command.includes('\n') || command.includes('\r')) throw new Error('Executor install command must be one physical line')
  return <section className="min-w-0 max-w-full overflow-hidden rounded-2xl bg-foreground text-background shadow-[0_12px_30px_hsl(var(--foreground)/0.12)]" data-testid="executor-terminal-command"><div className="flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-start"><span className="flex min-w-0 flex-1 items-start gap-3"><Terminal className="mt-0.5 h-4 w-4 flex-none opacity-55" aria-hidden="true" /><pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-5">{command || t('explorer.connectDialog.preparing')}</pre></span><Button type="button" variant="ghost" size="sm" className="h-9 w-full flex-none gap-1.5 rounded-lg bg-background/10 px-3 text-[11px] text-background hover:bg-background/20 hover:text-background sm:w-auto" onClick={onCopy} disabled={!command} data-testid="copy-executor-command">{copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? t('common.copied') : t('common.copy')}</Button></div></section>
}

function InstallStatus({ status, label }: { status: string; label: string }): JSX.Element {
  const completed = status === 'paired' || status === 'connected' || status === 'completed'
  const failed = status === 'failed' || status === 'rejected' || status === 'expired'
  const waiting = status === 'pairing_pending' || status === 'approval_pending'
  const Icon = completed ? CheckCircle2 : failed ? XCircle : waiting ? Clock3 : LoaderCircle
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 text-xs ${completed ? 'text-emerald-600 dark:text-emerald-300' : failed ? 'text-destructive' : waiting ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground'}`}
      data-testid="installation-status"
      aria-live="polite"
    >
      <Icon className={`h-3.5 w-3.5 flex-none ${!completed && !failed && !waiting ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}

function LinuxMark(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" aria-hidden="true">
      <path d="M8.2 15.7c-.8 1-1.4 2.2-1.5 3.5m9.1-3.5c.8 1 1.4 2.2 1.5 3.5M9.2 8.3c0-3 1.2-5.3 2.8-5.3s2.8 2.3 2.8 5.3c0 1.2-.2 2.3-.5 3.2 1.4 1 2.2 2.6 2.2 4.4 0 3-2 5.1-4.5 5.1s-4.5-2.1-4.5-5.1c0-1.8.8-3.4 2.2-4.4-.3-.9-.5-2-.5-3.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.6 8.2h.01M13.4 8.2h.01M10.8 10.4c.8.6 1.6.6 2.4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function toApiInput(form: FormState): CreateExecutorInstall {
  return { platform: form.platform, mode: form.mode, workspaceRoot: '__RUNLAB_CURRENT_DIRECTORY__' }
}

function sameForm(left: FormState, right: FormState): boolean {
  return JSON.stringify(toApiInput(left)) === JSON.stringify(toApiInput(right))
}

function updatePairingCode(value: ExecutorInstallEvent | ExecutorInstallStatusSnapshot, set: (code: string | null) => void): void {
  if (value.status !== 'pairing_pending') { set(null); return }
  const metadata = 'metadata' in value ? value.metadata : undefined
  const code = metadata?.pairingCode ?? metadata?.code
  set(typeof code === 'string' || typeof code === 'number' ? String(code) : null)
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(await response.text())
  return await response.json() as T
}

function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value) }

function detectCurrentPlatform(): ExecutorInstallPlatform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = (nav.userAgentData?.platform ?? navigator.platform ?? '').toLowerCase()
  if (platform.includes('win')) return 'windows'
  if (platform.includes('mac')) return 'macos'
  return 'linux'
}
