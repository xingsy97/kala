import { useState, type FormEvent } from 'react'
import { Minimize2, Send } from 'lucide-react'

import type { AgentState } from '@agent-kernel/kernel'
import type { ModelInfo } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js'
import { Textarea } from '../../components/ui/textarea.js'
import { cn } from '../../lib/utils.js'

type Props = {
  disabled?: boolean
  onSubmit(text: string): void
  onCompact(): void
  model: string
  models: readonly ModelInfo[]
  onModelChange(model: string): void
  status: string
  state: AgentState | null
}

export function Composer({
  disabled,
  onSubmit,
  onCompact,
  model,
  models,
  onModelChange,
  status,
  state,
}: Props): JSX.Element {
  const [text, setText] = useState('')

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    if (trimmed === '/compact') {
      onCompact()
      setText('')
      return
    }
    onSubmit(trimmed)
    setText('')
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    submit()
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950"
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        disabled={disabled}
        placeholder={
          disabled ? 'waiting for host…' : 'type a message and press Enter'
        }
        className="w-full resize-none border-0 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0"
        data-testid="composer-input"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="flex items-center gap-2 px-2 py-1.5 border-t border-slate-200 dark:border-slate-800">
        <Select
          value={model && models.some((m) => m.id === model) ? model : undefined}
          onValueChange={onModelChange}
          disabled={models.length === 0}
        >
          <SelectTrigger
            className="h-7 w-44 flex-none"
            data-testid="model-picker"
            aria-label="model"
          >
            <SelectValue
              placeholder={models.length === 0 ? 'no models' : 'model'}
            />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id} data-testid={`model-option-${m.id}`}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span
          className={cn(
            'flex-none whitespace-nowrap text-[11px] px-2 py-0.5 rounded-full',
            statusStyles(status),
          )}
          data-testid="connection-status"
        >
          {status}
        </span>
        <StateChips state={state} />
        <div className="flex-1" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={disabled}
          onClick={onCompact}
          aria-label="compact context"
          title="Compact context"
          data-testid="composer-compact"
          className="h-7 w-7"
        >
          <Minimize2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="submit"
          disabled={disabled || text.trim().length === 0}
          data-testid="composer-send"
          className="h-7 px-3"
        >
          <Send className="mr-1 h-3.5 w-3.5" />
          Send
        </Button>
      </div>
    </form>
  )
}

function StateChips({ state }: { state: AgentState | null }): JSX.Element | null {
  if (!state) return null
  return (
    <div
      className="hidden md:flex items-center gap-1 text-[11px] font-mono text-slate-500 dark:text-slate-400"
      data-testid="composer-state-chips"
    >
      <Chip label="status" value={state.status} tone={statusChipTone(state.status)} />
      <Chip label="cur" value={String(state.cursor)} />
      <Chip
        label="pend"
        value={String(state.pendingCalls.length)}
        tone={state.pendingCalls.length > 0 ? 'amber' : undefined}
      />
      <Chip
        label="tok"
        value={`${formatTokens(state.usage.inputTokens)} in / ${formatTokens(state.usage.outputTokens)} out`}
      />
    </div>
  )
}

type ChipTone = 'default' | 'green' | 'amber' | 'rose' | 'sky'

function Chip({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: ChipTone
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 border',
        chipToneStyles(tone),
      )}
      title={`${label}: ${value}`}
    >
      <span className="uppercase tracking-wide opacity-70">{label}</span>
      <span className="text-slate-800 dark:text-slate-100">{value}</span>
    </span>
  )
}

function chipToneStyles(tone: ChipTone | undefined): string {
  switch (tone) {
    case 'green':
      return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
    case 'amber':
      return 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300'
    case 'rose':
      return 'bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300'
    case 'sky':
      return 'bg-sky-500/10 border-sky-500/30 text-sky-700 dark:text-sky-300'
    default:
      return 'bg-slate-500/5 border-slate-300/40 dark:border-slate-700/60'
  }
}

function statusChipTone(status: AgentState['status']): ChipTone {
  switch (status) {
    case 'idle':
    case 'done':
      return 'green'
    case 'thinking':
    case 'executing_tools':
      return 'sky'
    case 'awaiting_approval':
      return 'amber'
    case 'error':
      return 'rose'
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function statusStyles(status: string): string {
  if (status === 'ready')
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
  if (status === 'error' || status === 'disconnected')
    return 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
  return 'bg-slate-500/15 text-slate-600 dark:text-slate-400'
}
