import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { Archive, AtSign, Bot, Check, ChevronDown, ChevronUp, CornerDownRight, Eraser, GripVertical, ListChecks, Navigation, PanelTopClose, PanelTopOpen, Pencil, ShieldCheck, SlidersHorizontal, Square, Trash2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import {
  MAX_MESSAGE_IMAGES,
  validateClientMessagePayload,
  validateInlineMessageImages,
  type ContextUsageSnapshot,
  type FileListEntry,
  type HumanAttentionTimeline,
  type ModelInfo,
  type QueuedMessagePreview,
} from '@agent-kernel/shared'
import type {
  AgentConfig,
  AgentState,
  ApprovalMode,
  ImageContent,
  MessageContent,
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
import { PREF_COMPOSER_DRAFT_PREFIX, PREF_COMPOSER_SEND_MODE_PREFIX } from '../../lib/prefs.js'
import { RuntimeMetrics } from './RuntimeMetrics.js'
import { HumanAttentionIndicator, shouldShowLowAttentionHint } from './HumanAttentionIndicator.js'
import type { TimelineEntry } from '../../session.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { SimpleComposerInput } from './composer/SimpleComposerInput.js'
import { useComposerMode } from './composer/useComposerMode.js'
import { chatDisplayStyle, type ChatDisplayPrefs } from './chatDisplayPrefs.js'
import { prepareComposerImage } from './image-compression.js'

type Props = {
  disabled?: boolean
  onSubmit(text: string, mode: SendMode, images?: readonly ImageContent[], extraBlocks?: readonly TextContent[]): void | Promise<void>
  onCompact(): void
  onCancel?(): void
  onClearSession?(): void
  onConsolidateMemory?(): void
  onRenameSession?(label: string | null): void
  onDeleteSession?(): void
  model: string
  models: readonly ModelInfo[]
  onModelChange(model: string): void
  approvalMode: ApprovalMode
  onApprovalModeChange(mode: ApprovalMode): void
  state: AgentState | null
  config: AgentConfig | null
  contextSnapshot: ContextUsageSnapshot | null
  humanAttention: HumanAttentionTimeline
  queuedMessages: readonly QueuedMessagePreview[]
  timeline?: readonly TimelineEntry[]
  displayPrefs?: ChatDisplayPrefs
  onQueuedReorder?(id: string, beforeId?: string | null): Promise<void>
  onQueuedUpdate?(id: string, text: string, content?: readonly MessageContent[]): Promise<void>
  onQueuedDelete?(id: string): Promise<void>
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
const SEND_MODE_STORAGE_PREFIX = PREF_COMPOSER_SEND_MODE_PREFIX
const QUEUED_MESSAGES_VISIBLE_LIMIT = 3

type PastedImage = {
  id: string
  dataUrl: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  base64: string
}

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

const DRAFT_STORAGE_PREFIX = PREF_COMPOSER_DRAFT_PREFIX

/** Read the saved, unsent composer draft for a session (empty when none). */
function readStoredDraft(sessionId: string | null): string {
  if (!sessionId || typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${sessionId}`) ?? ''
  } catch {
    return ''
  }
}

/** Persist (or, on empty, clear) the composer draft for a session. */
function writeStoredDraft(sessionId: string | null, text: string): void {
  if (!sessionId || typeof window === 'undefined') return
  try {
    if (text.length > 0) window.localStorage.setItem(`${DRAFT_STORAGE_PREFIX}${sessionId}`, text)
    else window.localStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${sessionId}`)
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
  onRenameSession,
  onDeleteSession,
  model,
  models,
  onModelChange,
  approvalMode,
  onApprovalModeChange,
  state,
  config,
  contextSnapshot,
  humanAttention,
  queuedMessages,
  timeline,
  displayPrefs,
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
  const lowAttentionHint = shouldShowLowAttentionHint(humanAttention)
  const placeholderText = disabled
    ? t('composer.waitingForHost')
    : lowAttentionHint
      ? isNarrow
        ? t('composer.placeholderLowAttentionShort')
        : t('composer.placeholderLowAttention')
    : isNarrow
      ? t('composer.placeholderShort')
      : t('composer.placeholder')
  const { mode, toggle: toggleMode } = useComposerMode()
  const displayStyle = chatDisplayStyle(displayPrefs)
  const sessionId = state?.sessionId ?? null
  const [text, setText] = useState<string>(() => readStoredDraft(sessionId))
  // Per-session draft persistence. Switching sessions must show that session's
  // own unsent draft, not whatever was typed in the previous one. We reload the
  // draft when the session changes and persist edits under the session they were
  // made in. `loadedDraftSession` guards the persist effect so it never writes
  // the outgoing session's text into the newly-selected session between the
  // session change and the reload.
  const loadedDraftSession = useRef<string | null>(sessionId)
  useEffect(() => {
    loadedDraftSession.current = sessionId
    setText(readStoredDraft(sessionId))
  }, [sessionId])
  const draftWriteTimer = useRef<number | null>(null)
  const latestDraft = useRef({ sessionId, text })
  useEffect(() => {
    if (loadedDraftSession.current !== sessionId) return
    latestDraft.current = { sessionId, text }
    if (draftWriteTimer.current !== null) window.clearTimeout(draftWriteTimer.current)
    draftWriteTimer.current = window.setTimeout(() => {
      writeStoredDraft(sessionId, text)
      draftWriteTimer.current = null
    }, 300)
    return () => {
      if (draftWriteTimer.current !== null) window.clearTimeout(draftWriteTimer.current)
      draftWriteTimer.current = null
    }
  }, [text, sessionId])
  useEffect(() => () => {
    const pending = latestDraft.current
    if (pending.sessionId === sessionId) writeStoredDraft(pending.sessionId, pending.text)
  }, [sessionId])
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
          command: '/stop',
          icon: Square,
          label: t('composer.slash.stop'),
          description: t('composer.slash.stopDesc'),
          run: onCancel,
        })
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
      if (onRenameSession) {
        commands.push({
          command: '/rename',
          icon: Pencil,
          label: t('composer.slash.rename'),
          description: t('composer.slash.renameDesc'),
          acceptsArgs: true,
          run: ({ args }) => {
            const label = args.trim()
            if (label === '--clear') {
              onRenameSession('')
              return
            }
            onRenameSession(label.length > 0 ? label : null)
          },
        })
      }
      if (onDeleteSession) {
        commands.push({
          command: '/delete',
          icon: Trash2,
          label: t('composer.slash.delete'),
          description: t('composer.slash.deleteDesc'),
          run: ({ args }) => {
            if (args.trim().length > 0) {
              setPendingToast(t('composer.slash.noArgs', { command: '/delete' }))
              return
            }
            onDeleteSession()
          },
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
    [onCompact, onCancel, onClearSession, onRenameSession, onDeleteSession, onConsolidateMemory, t],
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
    const parsedCommand = parseSlashCommand(trimmed)
    const command = parsedCommand
      ? slashCommands.find((c) => c.command === parsedCommand.name)
      : undefined
    if (command && pastedImages.length === 0) {
      if (!command.acceptsArgs && parsedCommand!.args.trim().length > 0) {
        setPendingToast(t('composer.slash.noArgs', { command: command.command }))
        return
      }
      command.run({ args: parsedCommand!.args })
      setText('')
      return
    }
    const images: ImageContent[] = pastedImages.map((img) => ({
      type: 'image',
      source: { kind: 'base64', mediaType: img.mediaType, data: img.base64 },
    }))
    const imageValidation = validateInlineMessageImages(images)
    if (!imageValidation.ok) {
      setPendingToast(imageValidation.error.message)
      return
    }
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
    const payloadError = validateClientMessagePayload({ text: trimmed, mode: sendMode, content: [...(trimmed ? [{ type: 'text', text: trimmed }] : []), ...extraBlocks, ...images] })
    if (payloadError) {
      setPendingToast(payloadError.message)
      return
    }
    const submittedText = text
    const submittedImages = pastedImages
    // Clear optimistically as soon as the operator submits. The Host ACK means
    // reliable acceptance, but an idle-session dispatch may not resolve until
    // the Agent turn completes. Keeping the submitted draft visible for that
    // whole period makes a successful send look broken and invites duplicates.
    setText('')
    setPastedImages([])
    setMentionState(null)
    setMentionFiles([])
    try {
      await onSubmit(
        trimmed,
        sendMode,
        images.length > 0 ? images : undefined,
        extraBlocks.length > 0 ? extraBlocks : undefined,
      )
    } catch (error) {
      // Restore only into an untouched composer. Never overwrite text or images
      // the operator added while the acknowledgement was pending.
      setText((current) => current.length === 0 ? submittedText : current)
      setPastedImages((current) => current.length === 0 ? submittedImages : current)
      setPendingToast(error instanceof Error ? error.message : String(error))
    }
  }

  async function extractImagesFromClipboardData(data: DataTransfer | null): Promise<PastedImage[]> {
    const items = Array.from(data?.items ?? [])
    const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    const added: PastedImage[] = []
    if (pastedImages.length + imageItems.length > MAX_MESSAGE_IMAGES) {
      setPendingToast(`A message can contain at most ${MAX_MESSAGE_IMAGES} images.`)
      return []
    }
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      const prepared = await prepareComposerImage(file)
      added.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl: prepared.dataUrl,
        mediaType: prepared.mediaType,
        base64: prepared.base64,
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

  const canSubmit = !disabled && workspaceOnline !== false && (text.trim().length > 0 || pastedImages.length > 0)
  const canStop = typeof onCancel === 'function' && (awaitingAck || isActiveTurnStatus(state?.status))
  const showStopButton = !canSubmit && canStop

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        'bg-card px-3 sm:px-6 lg:px-8',
        // Split the difference between the original full iOS safe-area shelf
        // and the too-tight fixed padding: half the safe area plus half the
        // compact baseline (2px simple / 4px full).
        mode === 'simple'
          ? 'pt-1 pb-[calc(env(safe-area-inset-bottom)/2+0.0625rem)] sm:pt-1.5 sm:pb-2'
          : 'pt-1.5 pb-[calc(env(safe-area-inset-bottom)/2+0.125rem)] sm:pt-2 sm:pb-4',
      )}
      style={displayStyle}
      data-testid="composer"
      data-composer-mode={mode}
    >
      <motion.div layout transition={{ type: 'spring', stiffness: 320, damping: 30 }} className="ak-chat-container relative mx-auto w-full">
        <QueuedMessagesDock
          items={queuedMessages}
          onReorder={onQueuedReorder}
          onUpdate={onQueuedUpdate}
          onDelete={onQueuedDelete}
        />
        {mode === 'simple' ? (
          <div className="relative flex items-center gap-0" data-testid="composer-simple-shell">
            <ComposerModeToggle mode={mode} onToggle={toggleMode} />
            <SlashCommandMenu
              commands={matchingCommands}
              disabled={disabled}
              onRun={(cmd) => {
                cmd.run({ args: '' })
                setText('')
              }}
              className="absolute inset-x-0 bottom-full z-20 mb-2"
            />
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
                className="rounded-l-none"
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
            <span className="hidden sm:inline-flex">
              <HumanAttentionIndicator timeline={humanAttention} density="simple" />
            </span>
            <SendButton
              disabled={!canSubmit}
              sendMode={sendMode}
              onSendModeChange={updateSendMode}
              density="simple"
              stop={showStopButton ? { onClick: onCancel } : undefined}
            />
          </div>
        ) : (
        <div className="flex items-stretch gap-0" data-testid="composer-full-shell">
          <ComposerModeToggle mode={mode} onToggle={toggleMode} />
        <div
          className={cn(
            'min-w-0 flex-1 relative rounded-2xl rounded-l-none border border-border/60 bg-background/60 transition-shadow',
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
              rows={1}
              disabled={disabled}
              placeholder={placeholderText}
              className="max-h-56 min-h-[40px] w-full resize-none overflow-y-auto overscroll-contain border-0 bg-transparent px-4 py-2.5 text-base leading-relaxed placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0 sm:text-sm"
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
            <SlashCommandMenu
              commands={matchingCommands}
              disabled={disabled}
              onRun={(cmd) => {
                cmd.run({ args: '' })
                setText('')
              }}
              className="absolute inset-x-2 bottom-2 z-10"
            />
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
            className="flex min-w-0 flex-row flex-wrap items-center gap-1.5 border-t border-border/50 px-2 py-2 sm:gap-2"
            data-testid="composer-footer"
          >
            <ComposerConfigButton
              model={model}
              models={models}
              onModelChange={onModelChange}
              approvalMode={approvalMode}
              approvalModeLabel={approvalModeLabel}
              onApprovalModeChange={onApprovalModeChange}
              composerMode={mode}
              onComposerModeChange={toggleMode}
              className="flex sm:hidden"
            />
            <div className="hidden min-w-0 items-center gap-1.5 sm:flex" data-testid="composer-footer-config">
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
            </div>
            {footerExtras}
            <div className="ml-auto flex min-w-0 max-w-full items-center gap-1.5 max-sm:w-full max-sm:justify-end" data-testid="composer-footer-actions">
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
              <HumanAttentionIndicator timeline={humanAttention} />
              <SendButton
                disabled={!canSubmit}
                sendMode={sendMode}
                onSendModeChange={updateSendMode}
                stop={showStopButton ? { onClick: onCancel } : undefined}
              />
            </div>
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

function ComposerModeToggle({ mode, onToggle }: { mode: 'simple' | 'full'; onToggle(): void }): JSX.Element {
  const { t } = useTranslation()
  const label = mode === 'simple' ? t('composer.mode.toFull') : t('composer.mode.toSimple')
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={mode === 'full'}
      aria-label={label}
      title={label}
      data-testid="composer-mode-toggle"
      data-composer-mode={mode}
      className={cn(
        'relative z-[1] flex h-10 w-10 flex-none self-start items-center justify-center rounded-l-2xl border border-r-0 border-border/60 bg-background/60 text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
      )}
    >
      {mode === 'simple'
        ? <PanelTopClose className="h-4 w-4" aria-hidden="true" />
        : <PanelTopOpen className="h-4 w-4" aria-hidden="true" />}
    </button>
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
          isSimple ? 'h-9 text-xs font-medium max-sm:px-3 sm:px-3.5' : 'h-8 text-xs font-medium max-sm:px-3 sm:px-3',
        )}
        aria-label={t('chatStatus.stopTitle')}
        title={t('chatStatus.stopTitle')}
      >
        <Square className={cn('h-3.5 w-3.5', 'sm:mr-1.5')} aria-hidden="true" />
        <span className="hidden sm:inline">{t('chatStatus.stop')}</span>
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
            ? 'h-9 rounded-r-none rounded-l-full text-xs font-medium shadow-sm max-sm:pl-3 max-sm:pr-2.5 sm:pl-3.5 sm:pr-3'
            : 'h-8 rounded-r-none rounded-l-full text-xs font-medium max-sm:pl-3 max-sm:pr-2.5 sm:pl-4 sm:pr-3',
          disabled ? 'opacity-50' : '',
        )}
        aria-label={t('composer.sendMessage', { mode: modeLabel })}
        title={modeHint}
      >
        <ModeIcon className={cn('h-3.5 w-3.5', 'sm:mr-1.5')} aria-hidden="true" />
        <span className="hidden sm:inline">{t('composer.send')}</span>
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
          className="absolute right-0 bottom-full z-20 mb-2 min-w-[15rem] w-[min(18rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] overflow-hidden overflow-x-hidden rounded-lg border border-border/60 bg-popover text-xs shadow-lg"
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

function ComposerConfigButton({
  model,
  models,
  onModelChange,
  approvalMode,
  approvalModeLabel,
  onApprovalModeChange,
  composerMode,
  onComposerModeChange,
  className,
}: {
  model: string
  models: readonly ModelInfo[]
  onModelChange(next: string): void
  approvalMode: ApprovalMode
  approvalModeLabel: string
  onApprovalModeChange(next: ApprovalMode): void
  composerMode: 'simple' | 'full'
  onComposerModeChange(): void
  className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent): void => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const activeModel = modelInfoFor(models, model ?? '')
  const modelSummary = activeModel?.label ?? t('common.model')
  const approvalTone =
    approvalMode === 'allow_all'
      ? 'text-rose-600 dark:text-rose-300'
      : approvalMode === 'ask'
        ? 'text-amber-600 dark:text-amber-300'
        : 'text-muted-foreground'

  return (
    <div className={cn('relative flex-none', className)} ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('composer.config.open')}
        title={t('composer.config.open')}
        aria-expanded={open}
        data-testid="composer-config-trigger"
        className={cn(
          'inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border border-border/50 bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          open && 'bg-accent text-foreground',
          approvalTone,
        )}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('composer.config.title')}
          className="fixed inset-x-2 bottom-[5.5rem] z-30 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border/60 bg-popover p-3 text-xs shadow-lg sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:mb-2 sm:w-[min(20rem,calc(100vw-1rem))]"
          data-testid="composer-config-popover"
        >
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('composer.config.title')}
          </div>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {t('common.model')}
                <span className="ml-auto truncate text-[10px] text-muted-foreground">{modelSummary}</span>
              </span>
              <Select
                value={activeModel ? model : ''}
                onValueChange={onModelChange}
                disabled={models.length === 0}
              >
                <SelectTrigger className="h-9 w-full" aria-label={t('common.model')}>
                  <SelectValue placeholder={models.length === 0 ? t('common.noModels') : t('common.model')} />
                </SelectTrigger>
                <SelectContent position="popper" sideOffset={4} className="max-h-[min(24rem,60vh)]">
                  {models.map((m) => {
                    const key = modelKey(m)
                    return (
                      <SelectItem key={key} value={key}>
                        {m.label}
                        {m.providerId ? <span className="ml-1 text-[10px] text-muted-foreground">{m.providerId}</span> : null}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                <ShieldCheck className={cn('h-3.5 w-3.5', approvalTone)} aria-hidden="true" />
                {t('composer.approvalMode')}
                <span className={cn('ml-auto truncate text-[10px]', approvalTone)}>{approvalModeLabel}</span>
              </span>
              <Select
                value={approvalMode}
                onValueChange={(v) => onApprovalModeChange(v as ApprovalMode)}
              >
                <SelectTrigger className="h-9 w-full" aria-label={t('composer.approvalMode')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" sideOffset={4} className="max-h-[min(24rem,60vh)]">
                  {APPROVAL_MODES.map((m) => {
                    const display = approvalModeDisplay(m.value, t)
                    return (
                      <SelectItem key={m.value} value={m.value} textValue={display.label}>
                        <div className="flex flex-col">
                          <span>{display.label}</span>
                          <span className="text-[10px] text-muted-foreground">{display.hint}</span>
                        </div>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </label>

            <label className="flex flex-col gap-1" data-testid="composer-config-mode">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                <span>Composer layout</span>
                <span className="ml-auto truncate text-[10px] text-muted-foreground">
                  {composerMode === 'simple' ? t('composer.mode.toFull').replace(/[（(].*[)）]/, '').trim() : t('composer.mode.toSimple').replace(/[（(].*[)）]/, '').trim()}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  onComposerModeChange()
                  setOpen(false)
                }}
                data-testid="composer-config-mode-toggle"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border/60 bg-background px-3 text-[11px] font-medium text-foreground hover:bg-accent"
              >
                {composerMode === 'simple' ? (
                  <>
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('composer.mode.toFull')}</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('composer.mode.toSimple')}</span>
                  </>
                )}
              </button>
            </label>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function queuedMessageSummary(item: QueuedMessagePreview, translate?: TFunction): string {
  const text = item.text.trim()
  const imageCount = item.content?.filter((part) => part.type === 'image').length ?? 0
  const imageTokens = Array.from({ length: imageCount }, (_, index) => translate
    ? translate('composer.queued.imageToken', { index: index + 1 })
    : `[Image #${index + 1}]`)
  return [text, ...imageTokens].filter(Boolean).join(' ') || (translate ? translate('composer.queued.empty') : '(empty queued message)')
}

function QueuedMessagesDock({
  items,
  onReorder,
  onUpdate,
  onDelete,
}: {
  items: readonly QueuedMessagePreview[]
  onReorder?(id: string, beforeId?: string | null): Promise<void>
  onUpdate?(id: string, text: string, content?: readonly MessageContent[]): Promise<void>
  onDelete?(id: string): Promise<void>
}): JSX.Element | null {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<{ id: string; message: string; retry(): Promise<void> } | null>(null)
  if (items.length === 0) return null
  const beginEdit = (item: QueuedMessagePreview): void => {
    setEditingId(item.id)
    setDraft(item.text)
  }
  const runMutation = async (id: string, operation: () => Promise<void>): Promise<void> => {
    setPendingId(id)
    setOperationError(null)
    try {
      await operation()
    } catch (error) {
      setOperationError({ id, message: error instanceof Error ? error.message : String(error), retry: operation })
      throw error
    } finally {
      setPendingId(null)
    }
  }
  const commitEdit = (): void => {
    if (!editingId) return
    const trimmed = draft.trim()
    const item = items.find((candidate) => candidate.id === editingId)
    const hasImages = item?.content?.some((part) => part.type === 'image') ?? false
    if ((trimmed.length > 0 || hasImages) && onUpdate) {
      const id = editingId
      void runMutation(id, () => onUpdate(id, trimmed, item?.content)).then(() => {
        setEditingId(null)
        setDraft('')
      }).catch(() => undefined)
    }
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
      if (before && onReorder) void runMutation(item.id, () => onReorder(item.id, before.id)).catch(() => undefined)
    } else {
      const afterNext = items[index + 2]
      if (onReorder) void runMutation(item.id, () => onReorder(item.id, afterNext?.id ?? null)).catch(() => undefined)
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
              title={queuedMessageSummary(item, t)}
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
                if (id && id !== item.id) void runMutation(id, () => onReorder(id, item.id)).catch(() => undefined)
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
                  {item.mode === 'steer' ? t('composer.queued.steerLabel') : t('composer.queued.queueLabel')}
                </span>
                {editingId === item.id ? (
                  <span className="flex min-w-0 flex-col gap-1">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit()
                      if (e.key === 'Escape') cancelEdit()
                    }}
                    className="h-6 w-full rounded border border-border/50 bg-background px-2 text-xs outline-none focus:border-ring"
                    data-testid="queued-message-edit-input"
                    placeholder={item.content?.some((part) => part.type === 'image') ? 'Optional message text' : undefined}
                    autoFocus
                  />
                  {item.content?.some((part) => part.type === 'image') ? (
                    <span className="truncate font-mono text-[10px] text-muted-foreground" data-testid="queued-message-edit-attachments">
                      {queuedMessageSummary({ ...item, text: '' }, t)}
                    </span>
                  ) : null}
                  </span>
                ) : (
                  <span className="block truncate text-foreground">
                    {queuedMessageSummary(item, t)}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-0.5" aria-busy={pendingId === item.id}>
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
                    <QueueAction label="delete queued message" onClick={() => { if (onDelete) void runMutation(item.id, () => onDelete(item.id)).catch(() => undefined) }} disabled={!onDelete || pendingId === item.id} testId="queued-message-delete">
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </QueueAction>
                  </>
                )}
              </span>
            </div>
          ))}
          {operationError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-destructive" role="alert" data-testid="queued-message-error">
              <span>{operationError.message}</span>{' '}
              <button type="button" className="font-medium underline" onClick={() => { void runMutation(operationError.id, operationError.retry).catch(() => undefined) }}>{t('common.retry')}</button>
            </div>
          ) : null}
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
  acceptsArgs?: boolean
  run(input: { args: string }): void
}

function parseSlashCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith('/')) return null
  const match = text.match(/^(\/\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return { name: match[1]!, args: match[2] ?? '' }
}

function SlashCommandMenu({
  commands,
  disabled,
  className,
  onRun,
}: {
  commands: readonly SlashCommand[]
  disabled?: boolean
  className?: string
  onRun(cmd: SlashCommand): void
}): JSX.Element | null {
  if (disabled || commands.length === 0) return null
  return (
    <div
      className={cn('overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg', className)}
      data-testid="slash-command-menu"
    >
      {commands.map((cmd, index) => {
        const Icon = cmd.icon
        return (
          <button
            key={cmd.command}
            type="button"
            className="flex w-full items-start gap-3 px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onRun(cmd)}
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
        )
      })}
    </div>
  )
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
