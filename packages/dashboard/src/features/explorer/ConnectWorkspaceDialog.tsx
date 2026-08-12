import { useEffect, useRef, useState } from 'react'
import { Apple, Check, Clipboard, Monitor, Terminal } from 'lucide-react'
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
} from '../../components/ui/dialog.js'

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
      const staleId = installationIdRef.current
      installationIdRef.current = null
      if (staleId) void fetch(`/api/executor-installs/${encodeURIComponent(staleId)}`, { method: 'DELETE' }).catch(() => undefined)
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
    const installationId = installation.id
    const generation = generationRef.current
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      void request<InstallResponse>(`/api/executor-installs/${encodeURIComponent(installationId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toApiInput(form)),
        signal: controller.signal,
      }).then((updated) => {
        if (generationRef.current !== generation) return
        createdFormRef.current = form
        setInstallation(updated)
        if (updated.command !== undefined) setCommand(updated.command)
        updatePairingCode(updated, setPairingCode)
        setError(null)
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
      <DialogContent className="grid max-h-[min(var(--ak-viewport-h,90dvh),52rem)] w-[calc(100vw-1rem)] min-w-0 max-w-4xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)] sm:w-[calc(100vw-2rem)]" data-testid="connect-workspace-dialog">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Terminal className="h-4 w-4" aria-hidden="true" />
            {t('explorer.connectDialog.title')}
          </DialogTitle>
          <DialogDescription>{t('explorer.connectDialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto p-4 sm:p-5">
          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <section className="min-w-0 space-y-5 rounded-2xl bg-muted/25 p-4">
              <PlatformGroup label={t('explorer.connectDialog.platform')} selected={form.platform} labelFor={(value) => t(`explorer.connectDialog.platforms.${value}`)} onChange={(platform) => updateForm({ platform })} />
              <ChoiceGroup label={t('explorer.connectDialog.runMode')} values={MODES} selected={form.mode} labelFor={(value) => t(`explorer.connectDialog.modes.${value}`)} onChange={(mode) => updateForm({ mode })} />
              <p className="rounded-xl bg-background/50 px-3 py-2 text-xs leading-5 text-muted-foreground">{t(`explorer.connectDialog.modeDescriptions.${form.mode}`)}</p>
            </section>
            <section className="min-w-0 space-y-4">
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t('explorer.connectDialog.runCommand')}</h3>
                <TerminalCommand command={command} copied={copied} onCopy={() => void copy()} />
              </div>
              <section className="space-y-2 rounded-xl bg-muted/25 p-4" aria-live="polite">
                <h3 className="text-sm font-medium">{t('explorer.connectDialog.installationStatus')}</h3>
                <p data-testid="installation-status" className="text-sm">{t(`explorer.connectDialog.statuses.${installation?.status ?? 'preparing'}`)}</p>
            {pairingCode ? (
              <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="font-mono text-lg font-semibold tracking-widest">{pairingCode}</span>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={deciding} onClick={() => void decide('approve')}>{t('explorer.connectDialog.approve')}</Button>
                  <Button size="sm" variant="outline" disabled={deciding} onClick={() => void decide('reject')}>{t('explorer.connectDialog.reject')}</Button>
                </div>
              </div>
            ) : null}
            {error || copyError ? <p className="text-sm text-destructive" role="alert">{error ?? copyError}</p> : null}
              </section>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PlatformGroup({ label, selected, labelFor, onChange }: { label: string; selected: ExecutorInstallPlatform; labelFor(value: ExecutorInstallPlatform): string; onChange(value: ExecutorInstallPlatform): void }): JSX.Element {
  const icons = { linux: <Terminal className="h-5 w-5" />, macos: <Apple className="h-5 w-5" />, windows: <Monitor className="h-5 w-5" /> }
  return <fieldset className="min-w-0 space-y-2"><legend className="text-sm font-medium">{label}</legend><div className="grid grid-cols-3 gap-2">{PLATFORMS.map((value) => <button key={value} type="button" aria-pressed={selected === value} data-testid={`connect-workspace-${value}`} onClick={() => onChange(value)} className={`flex min-w-0 flex-col items-center gap-2 rounded-xl px-2 py-3 text-xs transition-colors ${selected === value ? 'bg-primary/10 text-primary ring-1 ring-primary/25' : 'bg-background/50 text-muted-foreground hover:bg-accent hover:text-foreground'}`}>{icons[value]}<span className="truncate">{labelFor(value)}</span></button>)}</div></fieldset>
}

function ChoiceGroup<T extends string>({ label, values, selected, labelFor, onChange }: { label: string; values: readonly T[]; selected: T; labelFor(value: T): string; onChange(value: T): void }): JSX.Element {
  return <fieldset className="min-w-0 space-y-2"><legend className="text-sm font-medium">{label}</legend><div className="grid min-w-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap">{values.map((value) => <Button key={value} type="button" size="sm" variant={selected === value ? 'outline' : 'ghost'} aria-pressed={selected === value} data-testid={`connect-workspace-${value}`} onClick={() => onChange(value)}>{labelFor(value)}</Button>)}</div></fieldset>
}

function TerminalCommand({ command, copied, onCopy }: { command: string; copied: boolean; onCopy(): void }): JSX.Element {
  const { t } = useTranslation()
  if (command.includes('\n') || command.includes('\r')) throw new Error('Executor install command must be one physical line')
  return <section className="min-w-0 max-w-full overflow-hidden rounded-md bg-[#101216] shadow-xl ring-1 ring-black/30" data-testid="executor-terminal-command"><div className="flex h-9 min-w-0 items-center justify-end border-b border-white/10 bg-[#23252b] px-3"><Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px] text-zinc-300 hover:bg-white/10 hover:text-white" onClick={onCopy} disabled={!command} data-testid="copy-executor-command">{copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}{copied ? t('common.copied') : t('common.copy')}</Button></div><div className="min-w-0 max-w-full overflow-hidden px-4 py-4 font-mono text-[12px] leading-5 text-zinc-100"><pre className="max-w-full whitespace-pre-wrap break-all">{command || t('explorer.connectDialog.preparing')}</pre></div></section>
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
