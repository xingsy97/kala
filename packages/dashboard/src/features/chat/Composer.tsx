import { useMemo, useState, type FormEvent } from 'react'
import { Loader2, Minimize2, Send } from 'lucide-react'

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
  compacting?: boolean
  model: string
  models: readonly ModelInfo[]
  onModelChange(model: string): void
  status: string
}

export function Composer({
  disabled,
  onSubmit,
  onCompact,
  compacting = false,
  model,
  models,
  onModelChange,
  status,
}: Props): JSX.Element {
  const [text, setText] = useState('')
  const slashQuery = text.trimStart().startsWith('/') ? text.trimStart() : ''
  const slashCommands = useMemo(
    () => [
      {
        command: '/compact',
        label: 'Compact context',
        run: onCompact,
      },
    ],
    [onCompact],
  )
  const matchingCommands = slashQuery
    ? slashCommands.filter((c) => c.command.startsWith(slashQuery))
    : []

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const command = slashCommands.find(
      (c) => c.command === trimmed || (trimmed.startsWith('/') && c.command.startsWith(trimmed)),
    )
    if (command) {
      command.run()
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
      data-testid="composer"
    >
      <div className="relative">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          disabled={disabled}
          placeholder={
            disabled ? 'waiting for host...' : 'type a message or /compact'
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
        {matchingCommands.length > 0 && !disabled ? (
          <div
            className="absolute left-2 right-2 bottom-2 z-10 rounded border border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-950"
            data-testid="slash-command-menu"
          >
            {matchingCommands.map((cmd) => (
              <button
                key={cmd.command}
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-900"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  cmd.run()
                  setText('')
                }}
              >
                <span className="font-mono text-sky-700 dark:text-sky-300">
                  {cmd.command}
                </span>
                <span className="text-slate-700 dark:text-slate-200">
                  {cmd.label}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div
        className="flex items-center gap-2 px-2 py-1.5 border-t border-slate-200 dark:border-slate-800"
        data-testid="composer-footer"
      >
        <Select
          value={model && models.some((m) => m.id === model) ? model : ''}
          onValueChange={onModelChange}
          disabled={models.length === 0}
        >
          <SelectTrigger
            className="h-7 w-44 max-w-[calc(100vw-1rem)] flex-none"
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
          {hostStatusLabel(status)}
        </span>
        <div className="min-w-0 flex-1" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={disabled || compacting}
          onClick={onCompact}
          aria-label={compacting ? 'compacting context' : 'compact context'}
          title={compacting ? 'Compacting context' : 'Compact context'}
          data-testid="composer-compact"
          className="h-7 w-7 flex-none"
        >
          {compacting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Minimize2 className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          type="submit"
          disabled={disabled || text.trim().length === 0}
          data-testid="composer-send"
          className="h-7 flex-none px-3"
        >
          <Send className="mr-1 h-3.5 w-3.5" />
          Send
        </Button>
      </div>
    </form>
  )
}

function hostStatusLabel(status: string): string {
  if (status === 'ready') return 'Host ready'
  if (status === 'connecting') return 'Connecting'
  if (status === 'disconnected') return 'Disconnected'
  if (status === 'error') return 'Host error'
  return status
}

function statusStyles(status: string): string {
  if (status === 'ready')
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
  if (status === 'error' || status === 'disconnected')
    return 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
  return 'bg-slate-500/15 text-slate-600 dark:text-slate-400'
}
