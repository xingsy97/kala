import { useState, type FormEvent } from 'react'
import { Send } from 'lucide-react'

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
  model: string
  models: readonly ModelInfo[]
  onModelChange(model: string): void
  status: string
}

export function Composer({
  disabled,
  onSubmit,
  model,
  models,
  onModelChange,
  status,
}: Props): JSX.Element {
  const [text, setText] = useState('')

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
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
        <div className="flex-1" />
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

function statusStyles(status: string): string {
  if (status === 'ready')
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
  if (status === 'error' || status === 'disconnected')
    return 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
  return 'bg-slate-500/15 text-slate-600 dark:text-slate-400'
}
