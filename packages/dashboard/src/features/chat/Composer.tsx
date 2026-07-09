import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { Archive, AtSign, Bot, Check, ChevronDown, ChevronUp, CornerDownRight, Eraser, GripVertical, ListChecks, Navigation, Pencil, ShieldCheck, Square, Trash2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import type { ContextSnapshot, FileListEntry, ModelInfo, QueuedMessagePreview } from '@agent-kernel/shared'
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
import type { TimelineEntry } from '../../session.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { ComposerModeToggle } from './composer/ComposerModeToggle.js'
import { SimpleComposerInput } from './composer/SimpleComposerInput.js'
import { useComposerMode } from './composer/useComposerMode.js'

type Props = {
  disabled?: boolean
  onSubmit(text: string, mode: SendMode, images?: readonly ImageContent[], extraBlocks?: readonly TextContent[]): void
  onCompact(): void
  onCancel?(): void
  onClearSession?(): void
  onConsolidateMemory?(): void
  model: string
  models: readonly ModelInfo[]
  onModelChange(model: string): void
  approvalMode: ApprovalMode
  onApprovalModeChange(mode: ApprovalMode): void
  state: AgentState | null
  config: AgentConfig | null
  contextSnapshot: ContextSnapshot | null
  queuedMessages: readonly QueuedMessagePreview[]
  timeline?: readonly TimelineEntry[]
  onQueuedReorder?(id: string, beforeId?: string | null): void
  onQueuedUpdate?(id: string, text: string): void
  onQueuedDelete?(id: string): void
  workspaceOnline?: boolean
  onListFiles?(query: string): Promise<readonly FileListEntry[]>
  onReadFile?(path: string): Promise<{ content?: string; error?: string }>
  awaitingAck?: boolean
  /**
   * Extra controls rendered inline in the footer, immediately after the
   * approval-mode picker. Used e.g. by the background-shells trigger.
   */
  footerExtras?: React.ReactNode
}

export type SendMode = 'steer' | 'queue'
const SEND_MODE_STORAGE_PREFIX = 'agent-kernel:composer:send-mode:'
const QUEUED_MESSAGES_VISIBLE_LIMIT = 3

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

export const APPROVAL_MODES: ReadonlyArray<{
  value: ApprovalMode
  label: string
  hint: string
}> = [
  { value: 'auto', label: 'Auto', hint: 'ask only for tools marked unsafe' },
  { value: 'ask', label: 'Ask everything', hint: 'confirm every tool call' },
  { value: 'deny', label: 'Deny unsafe', hint: 'auto-reject anything unsafe' },
  { value: 'allow_all', label: 'Allow all', hint: 'Danger: bypass all approval prompts' },
]

const APPROVAL_MODE_BY_VALUE = new Map(APPROVAL_MODES.map((mode) => [mode.value, mode]))

function approvalModeDisplay(mode: ApprovalMode, t: TFunction): { label: string; hint: string } {
  if (mode === 'auto') return { label: t('composer.approvalModes.auto.label'), hint: t('composer.approvalModes.auto.hint') }
  if (mode === 'ask') return { label: t('composer.approvalModes.ask.label'), hint: t('composer.approvalModes.ask.hint') }
  if (mode === 'deny') return { label: t('composer.approvalModes.deny.label'), hint: t('composer.approvalModes.deny.hint') }
  if (mode === 'allow_all') return { label: t('composer.approvalModes.allowAll.label'), hint: t('composer.approvalModes.allowAll.hint') }
  const fallback = APPROVAL_MODE_BY_VALUE.get(mode)
  return { label: fallback?.label ?? mode, hint: fallback?.hint ?? '' }
}

function readStoredSendMode(sessionId: string | null): SendMode {
  if (!sessionId || typeof window === 'undefined') return 'steer'
  try {
    const value = window.localStorage.getItem(`${SEND_MODE_STORAGE_PREFIX}${sessionId}`)
    return value === 'queue' ? 'queue' : 'steer'
  } catch {
    return 'steer'
  }
}

function writeStoredSendMode(sessionId: string | null, mode: SendMode): void {
  if (!sessionId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${SEND_MODE_STORAGE_PREFIX}${sessionId}`, mode)
  } catch {
    // Storage can be unavailable in private mode or quota-exceeded states.
  }
}

function isActiveTurnStatus(status: AgentState['status'] | undefined): boolean {
  return status === 'thinking' || status === 'executing_tools' || status === 'awaiting_approval'
}

function useIsNarrow(): boolean {
  const query = '(max-width: 639px)'
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const media = window.matchMedia(query)
    const onChange = (): void => setMatches(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return matches
}

export function Composer({
  disabled,
  onSubmit,
  onCompact,
  onCancel,
  onClearSession,
  onConsolidateMemory,
  model,
  models,
  onModelChange,
  approvalMode,
  onApprovalModeChange,
  state,
  config,
  contextSnapshot,
  queuedMessages,
  timeline,
  onQueuedReorder,
  onQueuedUpdate,
  onQueuedDelete,
  workspaceOnline,
  onListFiles,
  onReadFile,
  awaitingAck = false,
  footerExtras,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const isNarrow = useIsNarrow()
  const placeholderText = disabled
    ? t('composer.waitingForHost')
    : isNarrow
      ? t('composer.placeholderShort')
      : t('composer.placeholder')
  const { mode, toggle: toggleMode } = useComposerMode()
  const sessionId = state?.sessionId ?? null
  const [text, setText] = useState('')
  const [sendMode, setSendMode] = useState<SendMode>(() => readStoredSendMode(sessionId))
  useEffect(() => {
    setSendMode(readStoredSendMode(sessionId))
  }, [sessionId])
  const updateSendMode = useCallback((next: SendMode): void => {
    setSendMode(next)
    writeStoredSendMode(sessionId, next)
  }, [sessionId])
  const [pastedImages, setPastedImages] = useState<readonly PastedImage[]>([])
  const [mentionState, setMentionState] = useState<MentionState | null>(null)
  const [mentionFiles, setMentionFiles] = useState<readonly FileListEntry[]>([])
  const [mentionActive, setMentionActive] = useState(0)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [pendingToast, setPendingToast] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionRequestId = useRef(0)
  const approvalModeLabel = approvalModeDisplay(approvalMode, t).label
  const slashQuery = text.trimStart().startsWith('/') ? text.trimStart() : ''
  const slashCommands = useMemo(
    () => {
      const commands: SlashCommand[] = [
        {
          command: '/compact',
          icon: Archive,
          label: t('composer.slash.compact'),
          description: t('composer.slash.compactDesc'),
          run: onCompact,
        },
      ]
      if (onCancel) {
        commands.push({
          command: '/cancel',
          icon: Square,
          label: t('composer.slash.cancel'),
          description: t('composer.slash.cancelDesc'),
          run: onCancel,
        })
      }
      if (onClearSession) {
        commands.push({
          command: '/clear',
          icon: Eraser,
          label: t('composer.slash.clear'),
          description: t('composer.slash.clearDesc'),
          run: onClearSession,
        })
      }
      if (onConsolidateMemory) {
        commands.push({
          command: '/consolidate-memory',
          icon: ListChecks,
          label: t('composer.slash.consolidateMemory'),
          description: t('composer.slash.consolidateMemoryDesc'),
          run: onConsolidateMemory,
        })
      }
      return commands
    },
    [onCompact, onCancel, onClearSession, onConsolidateMemory, t],
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

  async function extractImagesFromClipboardData(data: DataTransfer | null): Promise<PastedImage[]> {
    const items = Array.from(data?.items ?? [])
    const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
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
    return added
  }

  async function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const added = await extractImagesFromClipboardData(e.clipboardData)
    if (added.length === 0) return
    e.preventDefault()
    setPastedImages((prev) => [...prev, ...added])
  }

  async function handleSimplePaste(e: ClipboardEvent<HTMLDivElement>): Promise<void> {
    const added = await extractImagesFromClipboardData(e.clipboardData)
    if (added.length === 0) return
    e.preventDefault()
    setPastedImages((prev) => [...prev, ...added])
  }

  function removeImage(id: string): void {
    setPastedImages((prev) => prev.filter((img) => img.id !== id))
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    void submit()
  }

  const canSubmit = !disabled && (text.trim().length > 0 || pastedImages.length > 0)
  const canStop = typeof onCancel === 'function' && (awaitingAck || isActiveTurnStatus(state?.status))
  const showStopButton = !canSubmit && canStop

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        'bg-card px-3 sm:px-6 lg:px-8',
        mode === 'simple' ? 'py-1.5 sm:py-2' : 'py-2.5 sm:py-4',
      )}
      data-testid="composer"
      data-composer-mode={mode}
    >
      <motion.div layout transition={{ type: 'spring', stiffness: 320, damping: 30 }} className="mx-auto max-w-[68rem]">
        <QueuedMessagesDock
          items={queuedMessages}
          onReorder={onQueuedReorder}
          onUpdate={onQueuedUpdate}
          onDelete={onQueuedDelete}
        />
        {mode === 'simple' ? (
          <div className="relative flex items-center gap-2" data-testid="composer-simple-shell">
            <div className="min-w-0 flex-1">
              <SimpleComposerInput
                text={text}
                images={pastedImages.map((img) => ({ id: img.id, dataUrl: img.dataUrl }))}
                disabled={disabled}
                placeholder={placeholderText}
                ariaLabel={t('composer.placeholder')}
                onTextChange={(next) => setText(next)}
                onRemoveImage={(id) => removeImage(id)}
                onPaste={(e) => { void handleSimplePaste(e) }}
                onEnterSubmit={() => { void submit() }}
              />
            </div>
            <RuntimeMetrics
              state={state}
              config={config}
              contextSnapshot={contextSnapshot}
              modelInfo={modelInfoFor(models, model)}
              queuedMessages={queuedMessages.length}
              timeline={timeline}
              density="simple"
              onCompact={onCompact}
              compactDisabled={disabled}
            />
            <SendButton
              disabled={!canSubmit}
              sendMode={sendMode}
              onSendModeChange={updateSendMode}
              density="simple"
              stop={showStopButton ? { onClick: onCancel } : undefined}
            />
            <ComposerModeToggle
              mode={mode}
              onToggle={toggleMode}
              className="h-9 w-9 flex-none rounded-full border border-border/50 bg-muted/45 text-muted-foreground hover:bg-muted hover:text-foreground sm:h-9 sm:w-9"
            />
          </div>
        ) : (
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
                  className="group relative h-16 w-16 overflow-hidden rounded-lg border border-border/50 bg-background"
                  data-testid={`pasted-image-${img.id}`}
                >
                  <img src={img.dataUrl} alt={t('composer.pastedImage')} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
                    aria-label={t('composer.removeImage')}
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
              placeholder={placeholderText}
              className="max-h-56 min-h-[56px] w-full resize-none border-0 bg-transparent px-4 py-3 text-base leading-relaxed placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 sm:text-sm"
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
                {matchingCommands.map((cmd, index) => {
                  const Icon = cmd.icon
                  return (
                  <button
                    key={cmd.command}
                    type="button"
                    className="flex w-full items-start gap-3 px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      cmd.run()
                      setText('')
                    }}
                    data-testid={`slash-command-option-${index}`}
                  >
                    <Icon className="mt-0.5 h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="font-mono text-primary">{cmd.command}</span>
                        <span className="truncate text-foreground">{cmd.label}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{cmd.description}</span>
                    </span>
                  </button>
                )})}
              </div>
            ) : null}
            {mentionState && !disabled && onListFiles ? (
              <div
                className="absolute inset-x-2 bottom-2 z-10 max-h-[min(16rem,40vh)] overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg"
                data-testid="mention-menu"
              >
                <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <AtSign className="h-3 w-3" aria-hidden="true" />
                  <span>{t('composer.files')}</span>
                  {mentionState.query ? (
                    <span className="font-mono text-foreground">{mentionState.query}</span>
                  ) : null}
                  {mentionLoading ? <span className="ml-auto">…</span> : null}
                </div>
                <ScrollArea className="max-h-56" data-testid="mention-list">
                  {mentionFiles.length === 0 && !mentionLoading ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      {workspaceOnline === false ? t('composer.workspaceOffline') : t('composer.noMatches')}
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
                      <span className="font-mono truncate"><HighlightText text={file.path} query={mentionState.query} /></span>
                    </button>
                  ))}
                </ScrollArea>
              </div>
            ) : null}
          </div>
          <div
            className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border/50 px-2 py-2"
            data-testid="composer-footer"
          >
            <Select
              value={modelInfoFor(models, model ?? '') ? model : ''}
              onValueChange={onModelChange}
              disabled={models.length === 0}
            >
              <SelectTrigger
                className="h-9 w-11 flex-none gap-1 border-0 bg-transparent px-2 shadow-none hover:bg-accent md:h-7 md:w-24 xl:w-40"
                data-testid="model-picker"
                aria-label={t('common.model')}
              >
                <Bot className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
                <span className="hidden min-w-0 truncate md:inline">
                  <SelectValue
                    placeholder={models.length === 0 ? t('common.noModels') : t('common.model')}
                  />
                </span>
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4} className="max-h-[min(24rem,60vh)]">
                {models.map((m) => {
                  const key = modelKey(m)
                  return (
                  <SelectItem key={key} value={key} data-testid={`model-option-${key}`}>
                    {m.label}{m.providerId ? <span className="ml-1 text-[10px] text-muted-foreground">{m.providerId}</span> : null}
                  </SelectItem>
                )})}
              </SelectContent>
            </Select>
            <Select
              value={approvalMode}
              onValueChange={(v) => onApprovalModeChange(v as ApprovalMode)}
            >
              <SelectTrigger
                className={cn(
                  'h-9 w-11 flex-none border-0 bg-transparent px-2 shadow-none hover:bg-accent md:h-7 md:w-16 xl:w-32',
                  approvalMode === 'allow_all'
                    ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40'
                    : approvalMode === 'ask'
                      ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40'
                      : '',
                )}
                data-testid="approval-mode-picker"
                aria-label={t('composer.approvalMode')}
              >
                <ShieldCheck className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
                <span className="hidden min-w-0 truncate md:inline">{approvalModeLabel}</span>
              </SelectTrigger>
              <SelectContent position="popper" sideOffset={4} className="max-h-[min(24rem,60vh)]">
                {APPROVAL_MODES.map((m) => {
                  const display = approvalModeDisplay(m.value, t)
                  return (
                  <SelectItem
                    key={m.value}
                    value={m.value}
                    textValue={display.label}
                    data-testid={`approval-mode-option-${m.value}`}
                  >
                    <div className="flex flex-col">
                      <span>{display.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {display.hint}
                      </span>
                    </div>
                  </SelectItem>
                )})}
              </SelectContent>
            </Select>
            {footerExtras}
            <div className="ml-auto flex min-w-0 flex-none items-center gap-1.5 max-[420px]:basis-full max-[420px]:justify-end">
              <RuntimeMetrics
                state={state}
                config={config}
                contextSnapshot={contextSnapshot}
                modelInfo={modelInfoFor(models, model)}
                queuedMessages={queuedMessages.length}
                timeline={timeline}
                onCompact={onCompact}
                compactDisabled={disabled}
              />
              <SendButton
                disabled={!canSubmit}
                sendMode={sendMode}
                onSendModeChange={updateSendMode}
                stop={showStopButton ? { onClick: onCancel } : undefined}
              />
              <ComposerModeToggle
                mode={mode}
                onToggle={toggleMode}
                className="h-8 w-8 flex-none rounded-full border border-border/50 bg-muted/45 text-muted-foreground hover:bg-muted hover:text-foreground"
              />
            </div>
          </div>
        </div>
        )}
        {pendingToast ? (
          <div
            className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            data-testid="composer-toast"
          >
            {pendingToast}
          </div>
        ) : null}
      </motion.div>
    </form>
  )
}

function modelKey(model: ModelInfo): string {
  return model.ref ?? model.id
}

function modelInfoFor(models: readonly ModelInfo[], key: string): ModelInfo | null {
  const exact = models.find((m) => modelKey(m) === key)
  if (exact) return exact
  const byId = models.filter((m) => m.id === key)
  return byId.length === 1 ? byId[0]! : null
}

function SendButton({
  disabled,
  sendMode,
  onSendModeChange,
  density = 'default',
  stop,
}: {
  disabled: boolean
  sendMode: SendMode
  onSendModeChange(value: SendMode): void
  density?: 'default' | 'simple'
  stop?: { onClick?: () => void }
}): JSX.Element {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent): void => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  const ModeIcon = sendMode === 'steer' ? Navigation : ListChecks
  const modeLabel = sendMode === 'steer' ? t('composer.steerActiveTurn') : t('composer.queueFollowUp')
  const modeHint =
    sendMode === 'steer'
      ? t('composer.steerHint')
      : t('composer.queueHint')
  const isSimple = density === 'simple'

  if (stop) {
    return (
      <Button
        type="button"
        onClick={stop.onClick}
        disabled={!stop.onClick}
        data-testid="composer-stop"
        className={cn(
          'flex-none rounded-full bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
          isSimple ? 'h-9 px-3.5 text-xs font-medium' : 'h-8 px-3 text-xs font-medium',
        )}
        aria-label={t('chatStatus.stopTitle')}
        title={t('chatStatus.stopTitle')}
      >
        <Square className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        {t('chatStatus.stop')}
      </Button>
    )
  }

  return (
    <div
      className="relative flex flex-none"
      ref={containerRef}
      data-testid="send-mode-control"
    >
      <Button
        type="submit"
        disabled={disabled}
        data-testid="composer-send"
        className={cn(
          isSimple
            ? 'h-9 rounded-r-none rounded-l-full pl-3.5 pr-3 text-xs font-medium shadow-sm'
            : 'h-8 rounded-r-none rounded-l-full pl-4 pr-3 text-xs font-medium',
          disabled ? 'opacity-50' : '',
        )}
        aria-label={t('composer.sendMessage', { mode: modeLabel })}
        title={modeHint}
      >
        <ModeIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        {t('composer.send')}
      </Button>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className={cn(
          'flex flex-none items-center justify-center rounded-r-full border-l border-primary-foreground/30 bg-primary text-primary-foreground transition-colors hover:bg-primary/90',
          isSimple ? 'h-9 px-2.5 shadow-sm' : 'h-8 px-2',
        )}
        data-testid="send-mode-toggle"
        aria-label={t('chat.transcript.sendMode')}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
      >
        {menuOpen ? (
          <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
      {menuOpen ? (
        <div
          className="absolute right-0 bottom-full z-20 mb-2 min-w-[15rem] overflow-hidden rounded-lg border border-border/60 bg-popover text-xs shadow-lg"
          role="listbox"
          data-testid="send-mode-menu"
        >
          {(['steer', 'queue'] as const).map((mode) => {
            const Icon = mode === 'steer' ? Navigation : ListChecks
            const selected = sendMode === mode
            const label = mode === 'steer' ? t('composer.steerActiveTurn') : t('composer.queueFollowUp')
            const hint =
              mode === 'steer'
                ? t('composer.steerHint')
                : t('composer.queueHint')
            const longHint =
              mode === 'steer'
                ? t('composer.steerHint')
                : t('composer.queueHint')
            return (
              <button
                key={mode}
                type="button"
                role="option"
                aria-selected={selected}
                title={longHint}
                onClick={() => {
                  onSendModeChange(mode)
                  setMenuOpen(false)
                }}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground',
                  selected ? 'bg-accent/60 text-accent-foreground' : 'text-foreground',
                )}
                data-testid={`send-mode-${mode}`}
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{label}</span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {hint}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function QueuedMessagesDock({
  items,
  onReorder,
  onUpdate,
  onDelete,
}: {
  items: readonly QueuedMessagePreview[]
  onReorder?(id: string, beforeId?: string | null): void
  onUpdate?(id: string, text: string): void
  onDelete?(id: string): void
}): JSX.Element | null {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  if (items.length === 0) return null
  const beginEdit = (item: QueuedMessagePreview): void => {
    setEditingId(item.id)
    setDraft(item.text)
  }
  const commitEdit = (): void => {
    if (!editingId) return
    const trimmed = draft.trim()
    if (trimmed.length > 0) onUpdate?.(editingId, trimmed)
    setEditingId(null)
    setDraft('')
  }
  const cancelEdit = (): void => {
    setEditingId(null)
    setDraft('')
  }
  const move = (index: number, direction: -1 | 1): void => {
    const item = items[index]
    if (!item) return
    if (direction < 0) {
      const before = items[index - 1]
      if (before) onReorder?.(item.id, before.id)
    } else {
      const afterNext = items[index + 2]
      onReorder?.(item.id, afterNext?.id ?? null)
    }
  }
  return (
    <div
      className="mb-2 rounded-2xl border border-border/50 bg-muted/40 px-3 py-2 text-xs"
      data-testid="queued-messages-dock"
    >
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">
          <ListChecks className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
          <span>
            {t('composer.queued.pending', { count: items.length })}
          </span>
        </div>
        <span className="flex-none text-[11px] text-muted-foreground">
          {t('composer.queued.sendsAfterActiveTurn')}
        </span>
      </div>
      <ScrollArea
        className={cn(items.length > QUEUED_MESSAGES_VISIBLE_LIMIT && 'h-40 max-h-40')}
        data-testid="queued-messages-scrollarea"
      >
        <div className="space-y-1 pr-3">
          {items.map((item, index) => (
            <div
              key={item.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-lg border border-border/50 bg-background px-2 py-1.5"
              data-testid="queued-message-row"
              title={item.text}
              draggable={Boolean(onReorder)}
              onDragStart={(e) => {
                setDraggingId(item.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', item.id)
              }}
              onDragOver={(e) => {
                if (!onReorder) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                if (!onReorder) return
                e.preventDefault()
                const id = e.dataTransfer.getData('text/plain') || draggingId
                if (id && id !== item.id) onReorder(id, item.id)
                setDraggingId(null)
              }}
              onDragEnd={() => setDraggingId(null)}
            >
              <span className="mt-0.5 flex h-4 min-w-7 items-center justify-center gap-px rounded bg-muted font-mono text-[10px] text-muted-foreground">
                {onReorder ? <GripVertical className="h-2.5 w-2.5" aria-hidden="true" /> : null}
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="mb-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <CornerDownRight className="h-3 w-3" aria-hidden="true" />
                  {item.mode === 'steer' ? 'Steering update' : 'Queued follow-up'}
                </span>
                {editingId === item.id ? (
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit()
                      if (e.key === 'Escape') cancelEdit()
                    }}
                    className="h-6 w-full rounded border border-border/50 bg-background px-2 text-xs outline-none focus:border-ring"
                    data-testid="queued-message-edit-input"
                    autoFocus
                  />
                ) : (
                  <span className="block truncate text-foreground">
                    {item.text.trim().length > 0 ? item.text : '(image attachment)'}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-0.5">
                {editingId === item.id ? (
                  <>
                    <QueueAction label="save queued message" onClick={commitEdit} testId="queued-message-save">
                      <Check className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                    <QueueAction label="cancel edit" onClick={cancelEdit} testId="queued-message-cancel">
                      <X className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                  </>
                ) : (
                  <>
                    <QueueAction label="move queued message up" onClick={() => move(index, -1)} disabled={!onReorder || index === 0} testId="queued-message-up">
                      <ChevronUp className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                    <QueueAction label="move queued message down" onClick={() => move(index, 1)} disabled={!onReorder || index === items.length - 1} testId="queued-message-down">
                      <ChevronDown className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                    <QueueAction label="edit queued message" onClick={() => beginEdit(item)} disabled={!onUpdate} testId="queued-message-edit">
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                    <QueueAction label="delete queued message" onClick={() => onDelete?.(item.id)} disabled={!onDelete} testId="queued-message-delete">
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function QueueAction({
  children,
  label,
  onClick,
  disabled,
  testId,
}: {
  children: React.ReactNode
  label: string
  onClick(): void
  disabled?: boolean
  testId: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={testId}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
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

type SlashCommand = {
  command: string
  icon: LucideIcon
  label: string
  description: string
  run(): void
}

function HighlightText({ text, query }: { text: string; query: string }): JSX.Element {
  const needle = query.trim()
  if (!needle) return <>{text}</>
  const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (index === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-500/30" data-testid="mention-match-highlight">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  )
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
