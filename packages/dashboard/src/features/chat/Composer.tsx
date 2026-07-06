import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { AtSign, CornerDownRight, ListChecks, Navigation, Send, X } from 'lucide-react'

import type { FileListEntry, ModelInfo, QueuedMessagePreview } from '@agent-kernel/shared'
import type {
  AgentConfig,
  AgentState,
  ApprovalMode,
  ImageContent,
  TextContent,
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
import { RuntimeMetrics } from './RuntimeMetrics.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'

type Props = {
  disabled?: boolean
  onSubmit(text: string, mode: SendMode, images?: readonly ImageContent[], extraBlocks?: readonly TextContent[]): void
  onCompact(): void
  model: string
  models: readonly ModelInfo[]
  onModelChange(model: string): void
  approvalMode: ApprovalMode
  onApprovalModeChange(mode: ApprovalMode): void
  state: AgentState | null
  config: AgentConfig | null
  queuedMessages: readonly QueuedMessagePreview[]
  workspaceOnline?: boolean
  onListFiles?(query: string): Promise<readonly FileListEntry[]>
  onReadFile?(path: string): Promise<{ content?: string; error?: string }>
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

const APPROVAL_MODE_BY_VALUE = new Map(APPROVAL_MODES.map((mode) => [mode.value, mode]))

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
  workspaceOnline,
  onListFiles,
  onReadFile,
}: Props): JSX.Element {
  const [text, setText] = useState('')
  const [sendMode, setSendMode] = useState<SendMode>('steer')
  const [pastedImages, setPastedImages] = useState<readonly PastedImage[]>([])
  const [mentionState, setMentionState] = useState<MentionState | null>(null)
  const [mentionFiles, setMentionFiles] = useState<readonly FileListEntry[]>([])
  const [mentionActive, setMentionActive] = useState(0)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [pendingToast, setPendingToast] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionRequestId = useRef(0)
  const approvalModeLabel = APPROVAL_MODE_BY_VALUE.get(approvalMode)?.label ?? approvalMode
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

  useEffect(() => {
    if (!mentionState || !onListFiles) {
      if (mentionFiles.length > 0) setMentionFiles([])
      return
    }
    const rid = ++mentionRequestId.current
    setMentionLoading(true)
    let cancelled = false
    const handle = setTimeout(() => {
      onListFiles(mentionState.query)
        .then((files) => {
          if (cancelled || rid !== mentionRequestId.current) return
          setMentionFiles(files)
          setMentionActive(0)
          setMentionLoading(false)
        })
        .catch(() => {
          if (cancelled || rid !== mentionRequestId.current) return
          setMentionFiles([])
          setMentionLoading(false)
        })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [mentionState, onListFiles])

  useEffect(() => {
    if (!pendingToast) return
    const t = setTimeout(() => setPendingToast(null), 3500)
    return () => clearTimeout(t)
  }, [pendingToast])

  const updateText = (next: string, caret: number): void => {
    setText(next)
    const found = detectMention(next, caret)
    setMentionState(found)
    if (!found) mentionRequestId.current += 1
  }

  const applyMention = (file: FileListEntry): void => {
    if (!mentionState) return
    const before = text.slice(0, mentionState.start)
    const after = text.slice(mentionState.end)
    const inserted = `@${file.path}`
    const next = `${before}${inserted} ${after}`
    setText(next)
    setMentionState(null)
    setMentionFiles([])
    setMentionActive(0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      const pos = before.length + inserted.length + 1
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const submit = async (): Promise<void> => {
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
    const extraBlocks: TextContent[] = []
    if (onReadFile) {
      const mentions = collectMentionPaths(trimmed)
      const seen = new Set<string>()
      for (const path of mentions) {
        if (seen.has(path)) continue
        seen.add(path)
        try {
          const result = await onReadFile(path)
          if (result.error) {
            setPendingToast(`@${path}: ${result.error}`)
            continue
          }
          if (typeof result.content === 'string') {
            extraBlocks.push({
              type: 'text',
              text: `--- ${path} ---\n${result.content}\n---`,
            })
          }
        } catch (err) {
          setPendingToast(`@${path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    onSubmit(
      trimmed,
      sendMode,
      images.length > 0 ? images : undefined,
      extraBlocks.length > 0 ? extraBlocks : undefined,
    )
    setText('')
    setPastedImages([])
    setMentionState(null)
    setMentionFiles([])
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
    void submit()
  }

  const canSubmit = !disabled && (text.trim().length > 0 || pastedImages.length > 0)

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-card px-4 py-3 sm:px-6 sm:py-4 lg:px-8"
      data-testid="composer"
    >
      <div className="mx-auto max-w-[68rem]">
        <QueuedMessagesDock items={queuedMessages} />
        <div
          className={cn(
            'relative rounded-2xl border border-border/60 bg-background/60 transition-shadow',
            'focus-within:border-border focus-within:bg-background focus-within:ring-1 focus-within:ring-ring/40',
          )}
        >
          {pastedImages.length > 0 ? (
            <div
              className="flex flex-wrap gap-2 border-b border-border/50 px-3 py-2"
              data-testid="pasted-image-tray"
            >
              {pastedImages.map((img) => (
                <div
                  key={img.id}
                  className="group relative h-16 w-16 overflow-hidden rounded-lg border bg-background"
                  data-testid={`pasted-image-${img.id}`}
                >
                  <img src={img.dataUrl} alt="pasted" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
                    aria-label="remove image"
                    data-testid={`pasted-image-remove-${img.id}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="relative">
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => updateText(e.target.value, e.target.selectionStart ?? e.target.value.length)}
              onSelect={(e) => {
                const el = e.currentTarget
                if (mentionState !== null || el.value.includes('@')) {
                  const found = detectMention(el.value, el.selectionStart ?? el.value.length)
                  setMentionState(found)
                  if (!found) mentionRequestId.current += 1
                }
              }}
              rows={2}
              disabled={disabled}
              placeholder={
                disabled ? 'waiting for host...' : 'Message the agent  -  @ for files, / for commands'
              }
              className="max-h-56 min-h-[56px] w-full resize-none border-0 bg-transparent px-4 py-3 text-sm leading-relaxed placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              data-testid="composer-input"
              onPaste={(e) => {
                void handlePaste(e)
              }}
              onKeyDown={(e) => {
                if (mentionState && mentionFiles.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setMentionActive((i) => Math.min(mentionFiles.length - 1, i + 1))
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMentionActive((i) => Math.max(0, i - 1))
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    const file = mentionFiles[mentionActive]
                    if (file) {
                      e.preventDefault()
                      applyMention(file)
                      return
                    }
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setMentionState(null)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
            {matchingCommands.length > 0 && !disabled ? (
              <div
                className="absolute inset-x-2 bottom-2 z-10 overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg"
                data-testid="slash-command-menu"
              >
                {matchingCommands.map((cmd) => (
                  <button
                    key={cmd.command}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      cmd.run()
                      setText('')
                    }}
                  >
                    <span className="font-mono text-primary">{cmd.command}</span>
                    <span className="text-foreground">{cmd.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {mentionState && !disabled && onListFiles ? (
              <div
                className="absolute inset-x-2 bottom-2 z-10 max-h-64 overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg"
                data-testid="mention-menu"
              >
                <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <AtSign className="h-3 w-3" aria-hidden="true" />
                  <span>files</span>
                  {mentionState.query ? (
                    <span className="font-mono text-foreground">{mentionState.query}</span>
                  ) : null}
                  {mentionLoading ? <span className="ml-auto"> - </span> : null}
                </div>
                <div className="max-h-56 overflow-y-auto" data-testid="mention-list">
                  {mentionFiles.length === 0 && !mentionLoading ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {workspaceOnline === false ? 'workspace offline' : 'no matches'}
                    </div>
                  ) : null}
                  {mentionFiles.map((file, idx) => (
                    <button
                      key={file.path}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
                        idx === mentionActive
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-accent hover:text-accent-foreground',
                      )}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setMentionActive(idx)}
                      onClick={() => applyMention(file)}
                      data-testid={`mention-option-${idx}`}
                    >
                      <span className="font-mono truncate">{file.path}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <div
            className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border/50 px-2 py-2"
            data-testid="composer-footer"
          >
            <Select
              value={model && models.some((m) => m.id === model) ? model : ''}
              onValueChange={onModelChange}
              disabled={models.length === 0}
            >
              <SelectTrigger
                className="h-7 w-20 flex-none border-0 bg-transparent px-2 shadow-none hover:bg-accent md:w-24 xl:w-40"
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
                  'h-7 w-14 flex-none border-0 bg-transparent px-2 shadow-none hover:bg-accent md:w-16 xl:w-32',
                  approvalMode === 'allow_all'
                    ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40'
                    : approvalMode === 'ask'
                      ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40'
                      : '',
                )}
                data-testid="approval-mode-picker"
                aria-label="approval mode"
              >
                <span className="min-w-0 truncate">{approvalModeLabel}</span>
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
                      <span className="text-[10px] text-muted-foreground">
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
              queuedMessages={queuedMessages.length}
            />
            <SendModeControl value={sendMode} onChange={setSendMode} />
            <Button
              type="submit"
              disabled={!canSubmit}
              data-testid="composer-send"
              className={cn(
                'h-8 flex-none rounded-full px-4 text-xs font-medium',
                canSubmit ? '' : 'opacity-50',
              )}
              aria-label="send message"
            >
              <Send className="mr-1 h-3.5 w-3.5" />
              Send
            </Button>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 px-1 text-[10px] text-muted-foreground">
          <span>
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">Enter</kbd> to send  - 
            <kbd className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">Shift + Enter</kbd> for newline
          </span>
          <span>
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">@</kbd> files  - 
            <kbd className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">/</kbd> commands
          </span>
        </div>
        {pendingToast ? (
          <div
            className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            data-testid="composer-toast"
          >
            {pendingToast}
          </div>
        ) : null}
      </div>
    </form>
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
      className="flex flex-none rounded-md border border-border/50 bg-muted/40 p-0.5"
      data-testid="send-mode-control"
      aria-label="send mode"
    >
      {(['steer', 'queue'] as const).map((mode) => {
        const selected = value === mode
        const Icon = mode === 'steer' ? Navigation : ListChecks
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={cn(
              'flex h-6 items-center gap-1 rounded-sm px-2 text-[11px] transition-colors',
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            data-testid={`send-mode-${mode}`}
            aria-pressed={selected}
            title={
              mode === 'steer'
                ? 'Steer active turn: send feedback for the current run; if the agent is busy, it is promoted at the next safe boundary.'
                : 'Queue follow-up: hold this message until the current turn finishes, then send it in FIFO order.'
            }
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            {mode === 'steer' ? 'Steer active turn' : 'Queue follow-up'}
          </button>
        )
      })}
    </div>
  )
}

function QueuedMessagesDock({
  items,
}: {
  items: readonly QueuedMessagePreview[]
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div
      className="mb-2 rounded-2xl border border-border/50 bg-muted/40 px-3 py-2 text-xs"
      data-testid="queued-messages-dock"
    >
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
          <ListChecks className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
          <span>
            {items.length === 1 ? '1 pending delivery' : `${items.length} pending deliveries`}
          </span>
        </div>
        <span className="flex-none text-[11px] text-muted-foreground">
          Sends after the active turn
        </span>
      </div>
      <ScrollArea className="max-h-24" data-testid="queued-messages-scrollarea">
        <div className="space-y-1 pr-2">
          {items.map((item, index) => (
            <div
              key={item.id}
              className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 rounded-lg border border-border/50 bg-background px-2 py-1.5"
              data-testid="queued-message-row"
              title={item.text}
            >
              <span className="mt-0.5 flex h-5 min-w-5 items-center justify-center rounded bg-muted font-mono text-[10px] text-muted-foreground">
                #{index + 1}
              </span>
              <span className="min-w-0">
                <span className="mb-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <CornerDownRight className="h-3 w-3" aria-hidden="true" />
                  {item.mode === 'steer' ? 'Steering update' : 'Queued follow-up'}
                </span>
                <span className="block truncate text-foreground">
                  {item.text.trim().length > 0 ? item.text : '(image attachment)'}
                </span>
              </span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read pasted image'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

type MentionState = {
  start: number
  end: number
  query: string
}

const MENTION_CHAR = /[A-Za-z0-9._\-\/@]/
const MENTION_PATH = /[A-Za-z0-9._\-\/]/

function detectMention(text: string, caret: number): MentionState | null {
  const clamped = Math.min(caret, text.length)
  let start = clamped
  while (start > 0 && MENTION_CHAR.test(text[start - 1] ?? '')) start -= 1
  const at = text[start]
  if (at !== '@') return null
  if (start > 0) {
    const prev = text[start - 1] ?? ''
    if (prev !== '' && !/\s/.test(prev)) return null
  }
  let end = clamped
  while (end < text.length && MENTION_CHAR.test(text[end] ?? '')) end += 1
  const raw = text.slice(start + 1, end)
  if (/[\s@]/.test(raw)) return null
  return { start, end, query: raw }
}

function collectMentionPaths(text: string): readonly string[] {
  const out: string[] = []
  const re = /(^|\s)@([A-Za-z0-9._\-\/]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const path = m[2]
    if (path && path.length > 0 && !path.startsWith('/')) out.push(path)
  }
  return out
}

export const __TESTABLE__ = {
  detectMention,
  collectMentionPaths,
  MENTION_PATH,
}
