import { useMemo, useState, type ClipboardEvent, type FormEvent } from 'react'
import { Send, X } from 'lucide-react'

import type { ModelInfo } from '@agent-kernel/shared'
import type {
  AgentConfig,
  AgentState,
  ApprovalMode,
  ImageContent,
} from '@agent-kernel/kernel'

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
  onSubmit(text: string, mode: SendMode, images?: readonly ImageContent[]): void
  onCompact(): void
  model: string
  models: readonly ModelInfo[]
  onModelChange(model: string): void
  approvalMode: ApprovalMode
  onApprovalModeChange(mode: ApprovalMode): void
  state: AgentState | null
  config: AgentConfig | null
  queuedMessages: number
}

export type SendMode = 'steer' | 'queue'

type PastedImage = {
  id: string
  dataUrl: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  base64: string
}

const IMAGE_MEDIA_TYPES = new Set<PastedImage['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

const APPROVAL_MODES: ReadonlyArray<{
  value: ApprovalMode
  label: string
  hint: string
}> = [
  { value: 'auto', label: 'Auto', hint: 'ask only for tools marked unsafe' },
  { value: 'ask', label: 'Ask everything', hint: 'confirm every tool call' },
  { value: 'deny', label: 'Deny unsafe', hint: 'auto-reject anything unsafe' },
  { value: 'allow_all', label: 'Allow all (danger)', hint: 'bypass all approval prompts' },
]

export function Composer({
  disabled,
  onSubmit,
  onCompact,
  model,
  models,
  onModelChange,
  approvalMode,
  onApprovalModeChange,
  state,
  config,
  queuedMessages,
}: Props): JSX.Element {
  const [text, setText] = useState('')
  const [sendMode, setSendMode] = useState<SendMode>('steer')
  const [pastedImages, setPastedImages] = useState<readonly PastedImage[]>([])
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
    if (trimmed.length === 0 && pastedImages.length === 0) return
    const command = slashCommands.find(
      (c) => c.command === trimmed || (trimmed.startsWith('/') && c.command.startsWith(trimmed)),
    )
    if (command && pastedImages.length === 0) {
      command.run()
      setText('')
      return
    }
    const images: ImageContent[] = pastedImages.map((img) => ({
      type: 'image',
      source: { kind: 'base64', mediaType: img.mediaType, data: img.base64 },
    }))
    onSubmit(trimmed, sendMode, images.length > 0 ? images : undefined)
    setText('')
    setPastedImages([])
  }

  async function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault()
    const added: PastedImage[] = []
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      const mediaType = (IMAGE_MEDIA_TYPES.has(file.type as PastedImage['mediaType'])
        ? file.type
        : 'image/png') as PastedImage['mediaType']
      const dataUrl = await readFileAsDataUrl(file)
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      added.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl,
        mediaType,
        base64,
      })
    }
    if (added.length > 0) setPastedImages((prev) => [...prev, ...added])
  }

  function removeImage(id: string): void {
    setPastedImages((prev) => prev.filter((img) => img.id !== id))
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
        {pastedImages.length > 0 ? (
          <div
            className="flex flex-wrap gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/60"
            data-testid="pasted-image-tray"
          >
            {pastedImages.map((img) => (
              <div
                key={img.id}
                className="group relative h-16 w-16 overflow-hidden rounded border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900"
                data-testid={`pasted-image-${img.id}`}
              >
                <img src={img.dataUrl} alt="pasted" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
                  aria-label="remove image"
                  data-testid={`pasted-image-remove-${img.id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          disabled={disabled}
          placeholder={
            disabled ? 'waiting for host...' : 'type a message or /compact (paste images to attach)'
          }
          className="w-full resize-none border-0 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0"
          data-testid="composer-input"
          onPaste={(e) => {
            void handlePaste(e)
          }}
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
        className="flex min-w-0 items-center gap-1.5 px-2 py-1 border-t border-slate-200 dark:border-slate-800"
        data-testid="composer-footer"
      >
        <Select
          value={model && models.some((m) => m.id === model) ? model : ''}
          onValueChange={onModelChange}
          disabled={models.length === 0}
        >
          <SelectTrigger
            className="h-7 w-20 flex-none md:w-24 xl:w-40"
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
        <Select
          value={approvalMode}
          onValueChange={(v) => onApprovalModeChange(v as ApprovalMode)}
        >
          <SelectTrigger
            className={cn(
              'h-7 w-14 flex-none md:w-16 xl:w-32',
              approvalMode === 'allow_all'
                ? 'border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300'
                : approvalMode === 'ask'
                  ? 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300'
                  : '',
            )}
            data-testid="approval-mode-picker"
            aria-label="approval mode"
          >
            <SelectValue>
              {APPROVAL_MODES.find((m) => m.value === approvalMode)?.label ?? approvalMode}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {APPROVAL_MODES.map((m) => (
              <SelectItem
                key={m.value}
                value={m.value}
                textValue={m.label}
                data-testid={`approval-mode-option-${m.value}`}
              >
                <div className="flex flex-col">
                  <span>{m.label}</span>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400">
                    {m.hint}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <RuntimeMetrics
          state={state}
          config={config}
          modelInfo={models.find((m) => m.id === model) ?? null}
          queuedMessages={queuedMessages}
        />
        <SendModeControl value={sendMode} onChange={setSendMode} />
        <Button
          type="submit"
          disabled={disabled || (text.trim().length === 0 && pastedImages.length === 0)}
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

function RuntimeMetrics({
  state,
  config,
  modelInfo,
  queuedMessages,
}: {
  state: AgentState | null
  config: AgentConfig | null
  modelInfo: ModelInfo | null
  queuedMessages: number
}): JSX.Element {
  const inputTokens = state?.usage.inputTokens ?? 0
  const outputTokens = state?.usage.outputTokens ?? 0
  const totalContextWindow = modelInfo?.contextWindow ?? config?.contextLimit ?? null
  const userContextWindow = config?.contextLimit ?? totalContextWindow
  const ratio = userContextWindow && userContextWindow > 0
    ? Math.min(1, Math.max(0, inputTokens / userContextWindow))
    : 0
  const percent = Math.round(ratio * 100)
  const circumference = 2 * Math.PI * 8
  const dash = userContextWindow && userContextWindow > 0 ? circumference * ratio : 0
  const tone = state?.contextPressureLevel === 'hard'
    ? 'text-rose-600 dark:text-rose-300'
    : state?.contextPressureLevel === 'soft'
      ? 'text-amber-600 dark:text-amber-300'
      : 'text-sky-600 dark:text-sky-300'
  const title = userContextWindow && userContextWindow > 0
    ? `Context window: ${formatTokens(inputTokens)} of ${formatTokens(userContextWindow)} user tokens (${percent}%). Total model context window: ${totalContextWindow ? formatTokens(totalContextWindow) : 'unknown'} tokens. User context window: ${formatTokens(userContextWindow)} tokens.`
    : `Context window usage unavailable. Input tokens seen: ${formatTokens(inputTokens)}.`
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300"
      title={title}
      aria-label={title}
      data-testid="context-usage-indicator"
    >
      <svg viewBox="0 0 20 20" className="h-5 w-5 flex-none" aria-hidden="true">
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-slate-200 dark:text-slate-800"
        />
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform="rotate(-90 10 10)"
          className={tone}
        />
      </svg>
      <span className="min-w-0 flex-none whitespace-nowrap">
        {userContextWindow && userContextWindow > 0 ? `${percent}% context` : 'context n/a'}
      </span>
      <Metric label="Cursor" value={String(state?.cursor ?? 0)} className="hidden lg:inline-flex" />
      <Metric
        label="Pending"
        value={String(state?.pendingCalls.length ?? 0)}
        tone={(state?.pendingCalls.length ?? 0) > 0 ? 'amber' : undefined}
        className="hidden lg:inline-flex"
      />
      <Metric
        label="Tokens"
        value={`${formatTokens(inputTokens)} / ${formatTokens(outputTokens)}`}
        className="hidden 2xl:inline-flex"
      />
      {queuedMessages > 0 ? (
        <Metric label="Queued" value={String(queuedMessages)} tone="sky" />
      ) : null}
    </div>
  )
}

function Metric({
  label,
  value,
  tone,
  className,
}: {
  label: string
  value: string
  tone?: 'amber' | 'sky'
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'min-w-0 items-center gap-1 whitespace-nowrap border-l pl-1.5',
        tone === 'amber'
          ? 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300'
          : tone === 'sky'
            ? 'border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-300'
            : 'border-slate-300 dark:border-slate-700',
        className,
      )}
      title={`${label}: ${value}`}
    >
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-mono text-slate-800 dark:text-slate-100">{value}</span>
    </span>
  )
}

function SendModeControl({
  value,
  onChange,
}: {
  value: SendMode
  onChange(value: SendMode): void
}): JSX.Element {
  return (
    <div
      className="flex flex-none rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-800 dark:bg-slate-900"
      data-testid="send-mode-control"
      aria-label="send mode"
    >
      {(['steer', 'queue'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={cn(
            'h-6 rounded px-2 text-[11px] capitalize',
            value === mode
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100'
              : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
          )}
          data-testid={`send-mode-${mode}`}
          title={mode === 'steer' ? 'Interrupt or steer the current turn' : 'Add this message after the current turn'}
        >
          {mode === 'steer' ? 'Steer' : 'Queue'}
        </button>
      ))}
    </div>
  )
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read pasted image'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}
