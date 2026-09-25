/**
 * A single inline "what is the agent doing right now" row rendered at the tail
 * of the message flow. Reads `state.status` from the kernel — no invented
 * pseudo-statuses. During `thinking` a breathing activity dot accompanies the
 * live elapsed/progress label until the stream begins (at which point the
 * streaming assistant bubble takes over).
 * During `executing_tools` the currently-running tool calls are summarised
 * with an expandable parameter view. `awaiting_approval` renders a static
 * amber hint pointing to the approval card below. All other statuses render
 * nothing.
 *
 * A separate compact-feedback row (running / done / empty / error) is a
 * distinct concern that lives beside this component, not inside it: compact
 * is not an AgentStatus but a UI-level operation reporter.
 */

import { useEffect, useState } from 'react'
import { Check, Loader2, TriangleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AgentState } from '@agent-kernel/kernel'

import { cn } from '../../lib/utils.js'
import type { AgentProgress } from './agent-progress.js'

export type CompactStatus =
  | { kind: 'idle' }
  | { kind: 'queued' }
  | { kind: 'running'; startedAt: number; tokensBefore: number }
  | { kind: 'done' }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }

type Props = {
  state: AgentState | null
  fallbackStatus?: AgentState['status']
  streamingActive: boolean
  toolExecutionStartedAt?: number | null
  awaitingAck?: boolean
  progress?: AgentProgress
}

export function InlineStatusRow({ state, fallbackStatus, streamingActive, toolExecutionStartedAt, awaitingAck, progress }: Props): JSX.Element | null {
  const status = state?.status ?? fallbackStatus
  if (status) {
    switch (status) {
      case 'thinking':
        if (streamingActive) return null
        return <ThinkingRow key="thinking" progress={progress} />
      case 'executing_tools':
        return <ThinkingRow key="tools" progress={progress} startedAt={progress?.startedAt ?? toolExecutionStartedAt} />
      case 'awaiting_approval':
        return <ThinkingRow key="approval" progress={progress} />
    }
  }
  // Bridge the socket round-trip between user submit and the kernel's first
  // `thinking` status push — otherwise the transcript looks frozen.
  if (awaitingAck && !streamingActive) return <ThinkingRow progress={progress} />
  return null
}

function ThinkingRow({ progress, startedAt }: { progress?: AgentProgress; startedAt?: number | null }): JSX.Element {
  const { t } = useTranslation()
  const running = progress?.outcome === 'running' || (!progress?.outcome && progress?.phase !== 'approval')
  const elapsed = useElapsedSeconds(running, startedAt ?? progress?.startedAt, progress?.durationMs)
  const label = progress?.label ?? t('chatStatus.thinking')
  const completed = progress?.outcome === 'succeeded'
  const failed = progress?.outcome === 'failed'
  const approval = progress?.outcome === 'approval'
  return (
    <div
      className="ak-thinking-row mb-3 inline-grid overflow-hidden w-fit max-w-[calc(100%-2rem)] sm:max-w-[min(42rem,90%)] min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-xl border border-border/60 bg-card/90 px-3 py-2.5 text-xs text-foreground shadow-[0_4px_12px_hsl(var(--foreground)/0.06)] backdrop-blur-md dark:bg-zinc-950/80"
      data-testid="inline-status-thinking"
      role="status"
      aria-live="polite"
    >
      <span className="relative z-[1] mt-0.5 flex h-4 w-4 flex-none items-center justify-center text-primary">
        {completed ? <Check className="h-3.5 w-3.5 text-emerald-500" aria-label={t('chatStatus.succeeded')} />
          : failed ? <X className="h-3.5 w-3.5 text-rose-500" aria-label={t('chatStatus.failed')} />
            : approval ? <TriangleAlert className="h-3.5 w-3.5 text-amber-500" aria-label={t('chatStatus.approvalNeeded')} />
              : <span aria-hidden="true"><span className="absolute h-2 w-2 rounded-full bg-current opacity-15 ak-thinking-dot" /><span className="relative block h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_5px_hsl(var(--primary)/0.35)]" /></span>}
      </span>
      <span className="relative z-[1] flex min-w-0 items-center gap-2 font-semibold leading-5" data-testid="inline-status-label">
        <span>{label}</span>
        {elapsed !== undefined ? <span className="font-normal tabular-nums text-muted-foreground" data-testid="inline-status-elapsed">{Math.floor(elapsed)}s</span> : null}
      </span>
    </div>
  )
}

export function CompactFeedbackRow({
  kind,
  message,
  startedAt,
  tokensBefore,
  onDismiss,
}: {
  kind: 'queued' | 'running' | 'done' | 'empty' | 'error'
  message?: string
  startedAt?: number
  tokensBefore?: number
  onDismiss?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const isRunning = kind === 'running'
  const elapsedMs = useElapsedMs(isRunning, startedAt)
  if (kind === 'queued') {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        data-testid="inline-compact-queued"
        role="status"
      >
        <span className="relative flex h-2 w-2 flex-none items-center justify-center">
          <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400/60 opacity-75 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
        </span>
        <span className="font-medium">{t('chatStatus.compactQueued')}</span>
        <span className="truncate text-amber-700/70 dark:text-amber-300/70">
          {t('chatStatus.compactQueuedHint')}
        </span>
      </div>
    )
  }
  if (kind === 'running') {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        data-testid="inline-compact-running"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 flex-none animate-spin" />
        <span className="font-medium">{t('chatStatus.compacting')}</span>
        <span className="ml-auto tabular-nums text-amber-700/70 dark:text-amber-300/70">
          ↳ {(elapsedMs / 1000).toFixed(1)}s
          {typeof tokensBefore === 'number' ? ` · context ${formatTokensShort(tokensBefore)}` : ''}
        </span>
      </div>
    )
  }
  const palette =
    kind === 'error'
      ? 'border-rose-200 bg-rose-50/70 text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200'
      : 'border-emerald-200 bg-emerald-50/70 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200'
  return (
    <div
      className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-xs', palette)}
      data-testid={`inline-compact-${kind}`}
      role="status"
    >
      <span className="font-medium">
        {kind === 'done' && t('chatStatus.compactDone')}
        {kind === 'error' && t('chatStatus.compactFailed')}
        {kind === 'empty' && t('chatStatus.nothingToCompact')}
      </span>
      {message ? <span className="truncate opacity-80">· {message}</span> : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto rounded px-1 opacity-70 hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-current"
          aria-label={t('chatStatus.dismiss')}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}


export function pickPrimaryArg(name: string, input: Record<string, unknown>): string | null {
  const specialized = pickSpecializedPrimaryArg(name, input)
  if (specialized !== null) return specialized
  const candidates = ARG_PRIORITY[name] ?? DEFAULT_ARG_PRIORITY
  for (const key of candidates) {
    const v = input[key]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number') return String(v)
  }
  const first = Object.entries(input).find(([, v]) => typeof v === 'string' || typeof v === 'number')
  if (first) return String(first[1])
  return null
}

function pickSpecializedPrimaryArg(name: string, input: Record<string, unknown>): string | null {
  if (name === 'read_files') {
    const files = Array.isArray(input.files) ? input.files : []
    const first = files.find((file): file is Record<string, unknown> => !!file && typeof file === 'object')
    const firstPath = typeof first?.path === 'string' ? first.path : undefined
    if (firstPath) return files.length > 1 ? `${firstPath} +${files.length - 1}` : firstPath
    if (files.length > 0) return `${files.length} files`
  }
  if (name === 'apply_file_patch') {
    const patch = typeof input.patch === 'string' ? input.patch : ''
    const target = patch.split('\n').map((line) => {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
      return match?.[1]
    }).find((value): value is string => typeof value === 'string' && value.length > 0)
    if (target) return target
    if (patch.length > 0) return 'patch'
  }
  return null
}

const DEFAULT_ARG_PRIORITY: readonly string[] = ['path', 'command', 'query', 'pattern', 'url']
const ARG_PRIORITY: Record<string, readonly string[]> = {
  bash: ['command'],
  read: ['file_path', 'path'],
  read_file: ['path'],
  write: ['file_path', 'path'],
  write_file: ['path'],
  edit: ['file_path', 'path'],
  replace_in_file: ['path'],
  replace_many_in_file: ['path'],
  grep: ['pattern'],
  glob: ['pattern'],
  ls: ['path'],
}


export function formatTokensShort(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k tokens`
  return `${(tokens / 1_000_000).toFixed(1)}m tokens`
}

export function useElapsedSeconds(active: boolean, startedAt?: number | null, fixedDurationMs?: number): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || startedAt === undefined || startedAt === null) return
    setNow(Date.now())
    let t: number | undefined
    const tick = (): void => {
      setNow(Date.now())
      t = window.setTimeout(tick, 100)
    }
    t = window.setTimeout(tick, 100)
    return () => { if (t !== undefined) window.clearTimeout(t) }
  }, [active, startedAt])
  if (fixedDurationMs !== undefined) return Math.max(0, fixedDurationMs / 1000)
  if (startedAt === undefined || startedAt === null) return undefined
  // Do not invent 0s when the browser clock trails the Host. The timer will
  // appear once local wall time reaches the authoritative turn start.
  if (now < startedAt) return undefined
  return (now - startedAt) / 1000
}

function useElapsedMs(active: boolean, startedAt?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    let t: number | undefined
    const tick = (): void => {
      setNow(Date.now())
      t = window.setTimeout(tick, 100)
    }
    t = window.setTimeout(tick, 100)
    return () => { if (t !== undefined) window.clearTimeout(t) }
  }, [active])
  if (!startedAt) return 0
  return Math.max(0, now - startedAt)
}
