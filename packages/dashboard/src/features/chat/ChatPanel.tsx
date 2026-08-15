import {
  Children,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  Code2,
  Copy,
  FileText,
  FileSearch,
  Globe,
  GripVertical,
  Image,
  Lightbulb,
  ListChecks,
  Maximize2,
  Pencil,
  PenLine,
  RotateCcw,
  Sparkles,
  Terminal,
  Eye,
  Brain,
  Bot,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import type {
  Message,
  MessageContent,
  ToolCallContent,
  ToolResultContent,
} from '@agent-kernel/kernel'
import type { ApprovalRequiredEvent, ToolCardMode } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { Textarea } from '../../components/ui/textarea.js'
import { Typewriter } from '../../components/Typewriter.js'
import { formatTokens } from '../../lib/format.js'
import { DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT, DEFAULT_TOOL_ACTIVITY_ICON_SCALE, PREF_SMOOTH_STREAMING_TEXT, PREF_TOOL_ACTIVITY_ICON_SCALE, useBooleanPref, useNumberPref } from '../../lib/prefs.js'
import { cn } from '../../lib/utils.js'
import type { TranscriptItem } from '../../transcript.js'
import { DiffPreview, hasDiffPreviewForTool } from './DiffPreview.js'
import { CodeBlock } from './CodeBlock.js'
import { MermaidBlock } from './MermaidBlock.js'
import { CompactFeedbackRow, useElapsedSeconds, type CompactStatus } from './InlineStatusRow.js'
import {
  type GroupedContentItem,
  type ToolCallGroup,
  collectAllToolResults,
  groupConsecutiveToolCalls,
  makeToolCallGroup,
} from './grouping.js'
import { SubAgentCard } from './SubAgentCard.js'
import { GroupSummaryPreview, GroupSummaryRow, firstLine, pickRenderer, truncate, type SummaryDelta, type SummaryRow } from './toolSummaries/index.js'
import type { DashboardSocket } from '../../session.js'
import { RevealCursor, RevealTail, canFadeRevealTail } from './text-reveal/index.js'
import { VirtualTranscript, type VirtualTranscriptHandle } from './VirtualTranscript.js'
import { chatDisplayStyle, type ChatDisplayPrefs } from './chatDisplayPrefs.js'
import { transcriptItemKey } from './transcript-key.js'
import { toolDotRailBudget, toolPreviewGeometry, visibleToolDots, type ToolPreviewGeometry } from './tool-dot-layout.js'

type Props = {
  messages?: readonly Message[]
  items?: readonly TranscriptItem[]
  highlightIndex?: number | null
  onEditAndRerun?: (seq: number, text: string) => void
  onSuggest?: (text: string) => void
  pendingApprovals?: readonly ApprovalRequiredEvent[]
  /** Authoritative live calls from AgentState.pendingCalls. */
  activeToolCallIds?: readonly string[]
  /** Tool Intention currently owned by the persistent Agent activity Badge. */
  badgeIntentionCallId?: string
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  onReadOverflow?: (callId: string) => Promise<{ content?: string; error?: string }>
  footerSlot?: JSX.Element | null
  /**
   * Wiring for inline `SubAgentCard`s. When both are present, tool_call
   * groups with `toolName === 'agent'` render as a live nested view (with
   * child transcript mirrored via socket) instead of the generic
   * ToolCallGroupBlock. Optional so nested read-only panels — which pass
   * no socket — degrade to a static replay from the `<sub_agent>` envelope.
   */
  parentSessionId?: string
  sessionId?: string | null
  socket?: DashboardSocket | null
  /**
   * Two-way pinned-to-bottom binding. `pinned` starts true and flips as the
   * user scrolls away from / back to the bottom. When true, appending items
   * (new messages, streaming) auto-scrolls. Caller resets this when the
   * session changes so a fresh conversation starts pinned.
   */
  pinnedToBottom?: boolean
  onPinnedChange?: (pinned: boolean) => void
  /** Bump this to make ChatPanel scroll to the current bottom. */
  scrollToBottomToken?: number
  /** UI-level compaction operation status rendered inline at transcript tail. */
  compactStatus?: CompactStatus
  liveToolActivityTailCount?: number
  toolExecutionStartedAt?: number | null
  toolCardMode?: ToolCardMode
  displayPrefs?: ChatDisplayPrefs
  onDismissCompactStatus?: () => void
  loading?: boolean
  onOpenWorkspaceFile?: (target: WorkspaceFileTarget) => void
}

export type WorkspaceFileTarget = {
  path: string
  line?: number
  column?: number
}

const WorkspaceFileLinkContext = createContext<((target: WorkspaceFileTarget) => void) | null>(null)
const ArtifactSessionContext = createContext<string | null>(null)

type RenderTranscriptItem = TranscriptItem | {
  kind: 'compact_feedback'
  status: Exclude<CompactStatus, { kind: 'idle' }>
} | {
  kind: 'tool_activity'
  group: ToolCallGroup
  firstMessageIndex: number
  lastMessageIndex: number
  seq?: number
  ts?: string
}

type MessageRerunTarget = {
  seq: number
  text: string
}

type OverflowReader = (callId: string) => Promise<{ content?: string; error?: string }>
const OverflowReaderContext = createContext<OverflowReader | null>(null)

const EMPTY_SUGGESTIONS: ReadonlyArray<{
  icon: typeof Sparkles
  title: string
  prompt: string
}> = [
  {
    icon: Code2,
    title: 'Explain this repo',
    prompt: 'Give me a quick tour of this repository — what does it do, and where should I start reading?',
  },
  {
    icon: Terminal,
    title: 'Run tests and fix failures',
    prompt: 'Run the tests. If any fail, propose a fix.',
  },
  {
    icon: FileText,
    title: 'Draft a change plan',
    prompt: 'I want to add a new feature. Ask me a few clarifying questions, then draft an implementation plan.',
  },
  {
    icon: Lightbulb,
    title: 'Suggest improvements',
    prompt: 'Read the main source files and suggest three concrete improvements I could make today.',
  },
]

export function ChatPanel({
  messages,
  items,
  highlightIndex,
  onEditAndRerun,
  onSuggest,
  pendingApprovals,
  activeToolCallIds,
  badgeIntentionCallId,
  onApprovalDecision,
  onReadOverflow,
  footerSlot,
  parentSessionId,
  sessionId,
  socket,
  pinnedToBottom,
  onPinnedChange,
  scrollToBottomToken,
  compactStatus,
  liveToolActivityTailCount = DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  toolExecutionStartedAt,
  toolCardMode = 'dots',
  displayPrefs,
  onDismissCompactStatus,
  loading = false,
  onOpenWorkspaceFile,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const fallbackItems = useMemo<TranscriptItem[]>(() => (messages ?? [])
    .filter((message) => message.role !== 'system')
    .map((message) => ({ kind: 'message', message })), [messages])
  const rawItems = items ?? fallbackItems
  const { toolNameByCallId, allMessages, resultsByCallId, intraMessageGroupedCallIds } = useMemo(() => {
    const names = new Map<string, string>()
    const messageItems = rawItems
      .filter((item): item is Extract<TranscriptItem, { kind: 'message' }> => item.kind === 'message')
      .map((item) => item.message)
    for (const message of messageItems) {
      for (const content of message.content) {
        if (content.type === 'tool_call') names.set(content.callId, content.name)
      }
    }
    const results = collectAllToolResults(messageItems)
    const groupedIds = new Set<string>()
    for (const message of messageItems) {
      if (message.role !== 'assistant') continue
      for (const group of groupConsecutiveToolCalls(message.content, results)) {
        if (group.kind === 'tool_call_group') for (const call of group.calls) groupedIds.add(call.callId)
      }
    }
    return { toolNameByCallId: names, allMessages: messageItems, resultsByCallId: results, intraMessageGroupedCallIds: groupedIds }
  }, [rawItems])
  const approvalByCallId = useMemo(() => new Map((pendingApprovals ?? []).map((approval) => [approval.callId, approval])), [pendingApprovals])
  // Null preserves the legacy standalone/demo fallback. The product App always
  // supplies the authoritative set so an unpaired historical call cannot be
  // mistaken for live work after compaction, interruption, or recovery.
  const activeToolCallIdSet = useMemo(() => activeToolCallIds === undefined ? null : new Set(activeToolCallIds), [activeToolCallIds])

  // Drop tool messages whose every tool_result is already rendered inline in a
  // grouped assistant tool-call card. Otherwise MessageRow returns null but
  // Virtuoso's per-item wrapper still occupies `py-2 sm:py-3` — with 5+ tool
  // calls per group that stacks up to a screen of blank space between groups.
  //
  // messageIndex (used for msg-* anchors + highlight) must still count against
  // the ORIGINAL sequence so callers that pass a highlight seq still land on
  // the right row.
  const { transcriptItems, messageIndexByItem, hideHeaderByItem, groupedCallIds } = useMemo(() => {
    const kept: RenderTranscriptItem[] = []
    const mapping: number[] = []
    const hideHeader: boolean[] = []
    const groupedIds = new Set(intraMessageGroupedCallIds)
    let mi = -1
    let prevRole: 'user' | 'assistant' | 'tool' | null = null
    let i = 0
    while (i < rawItems.length) {
      const transcriptGroup = collectTranscriptToolActivity(
        rawItems,
        i,
        mi,
        resultsByCallId,
        {
          absorbReasoning: toolCardMode === 'dots',
          preserveAgentCalls: Boolean(parentSessionId),
        },
      )
      if (transcriptGroup) {
        const narrativeEntries = toolCardMode === 'dots'
          ? [...transcriptGroup.before, ...transcriptGroup.after]
          : transcriptGroup.before
        for (const entry of narrativeEntries) {
          kept.push(entry.item)
          mapping.push(entry.messageIndex)
          hideHeader.push(prevRole === 'assistant')
          prevRole = 'assistant'
        }
        kept.push({
          kind: 'tool_activity',
          group: transcriptGroup.group,
          firstMessageIndex: transcriptGroup.firstMessageIndex,
          lastMessageIndex: transcriptGroup.lastMessageIndex,
          seq: transcriptGroup.seq,
          ts: transcriptGroup.ts,
        })
        mapping.push(transcriptGroup.firstMessageIndex)
        hideHeader.push(prevRole === 'assistant')
        prevRole = 'assistant'
        if (toolCardMode !== 'dots') {
          for (const entry of transcriptGroup.after) {
            kept.push(entry.item)
            mapping.push(entry.messageIndex)
            hideHeader.push(true)
          }
        }
        for (const call of transcriptGroup.group.calls) groupedIds.add(call.callId)
        mi = transcriptGroup.lastMessageIndex
        i = transcriptGroup.nextIndex
        continue
      }

      const it = rawItems[i]!
      if (it.kind === 'message') {
        mi += 1
        const m = it.message
        if (m.role === 'tool') {
          const hasVisible = m.content.some(
            (c) => c.type !== 'tool_result' || !groupedIds.has(c.callId),
          )
          if (!hasVisible) {
            i += 1
            continue
          }
        }
        kept.push(it)
        mapping.push(mi)
        hideHeader.push(prevRole === m.role)
        prevRole = m.role as 'user' | 'assistant' | 'tool'
      } else if (it.kind === 'pending_user_message') {
        kept.push(it)
        mapping.push(-1)
        hideHeader.push(prevRole === 'user')
        prevRole = 'user'
      } else {
        kept.push(it)
        mapping.push(-1)
        hideHeader.push(false)
        prevRole = null
      }
      i += 1
    }
    if (compactStatus && compactStatus.kind !== 'idle') {
      kept.push({ kind: 'compact_feedback', status: compactStatus })
      mapping.push(-1)
      hideHeader.push(false)
    }
    return { transcriptItems: kept, messageIndexByItem: mapping, hideHeaderByItem: hideHeader, groupedCallIds: groupedIds }
  }, [rawItems, intraMessageGroupedCallIds, resultsByCallId, compactStatus, parentSessionId, toolCardMode])

  // Translate message-index highlight into item-index so VirtualTranscript
  // can scroll to the right row. -1 means "no highlight" or unresolved.
  const highlightItemIndex = useMemo(() => {
    if (highlightIndex == null || highlightIndex < 0) return null
    for (let i = 0; i < messageIndexByItem.length; i += 1) {
      if (messageIndexByItem[i] === highlightIndex) return i
      const item = transcriptItems[i]
      if (
        item?.kind === 'tool_activity' &&
        highlightIndex >= item.firstMessageIndex &&
        highlightIndex <= item.lastMessageIndex
      ) {
        return i
      }
    }
    return null
  }, [highlightIndex, messageIndexByItem, transcriptItems])

  const isEmpty = transcriptItems.length === 0

  const renderItem = useCallback(
    (item: RenderTranscriptItem, itemIndex: number): JSX.Element => {
      if (item.kind === 'compact_boundary') {
        return <CompactBoundaryRow boundary={item} />
      }
      if (item.kind === 'compact_feedback') {
        return <CompactFeedbackTranscriptRow status={item.status} onDismiss={onDismissCompactStatus} />
      }
      const hideHeader = hideHeaderByItem[itemIndex] ?? false
      if (item.kind === 'tool_activity') {
        return (
          <ToolActivityTranscriptRow
            item={item}
            highlighted={
              highlightIndex != null &&
              highlightIndex >= item.firstMessageIndex &&
              highlightIndex <= item.lastMessageIndex
            }
            hideHeader={hideHeader}
            approvalByCallId={approvalByCallId}
            onApprovalDecision={onApprovalDecision}
            liveToolActivityTailCount={liveToolActivityTailCount}
            toolExecutionStartedAt={toolExecutionStartedAt}
            toolCardMode={toolCardMode}
            activeToolCallIds={activeToolCallIdSet}
            badgeIntentionCallId={badgeIntentionCallId}
          />
        )
      }
      if (item.kind === 'pending_user_message') {
        return <PendingUserMessageRow item={item} />
      }
      const currentMessageIndex = messageIndexByItem[itemIndex] ?? 0
      const assistantRerunTarget =
        item.message.role === 'assistant'
          ? previousUserRerunTarget(transcriptItems, itemIndex)
          : null
      return (
        <MessageRow
          index={currentMessageIndex}
          message={item.message}
          streaming={item.streaming === true}
          highlighted={highlightIndex === currentMessageIndex}
          toolNameByCallId={toolNameByCallId}
          approvalByCallId={approvalByCallId}
          onApprovalDecision={onApprovalDecision}
          resultsByCallId={resultsByCallId}
          groupedCallIds={groupedCallIds}
          seq={item.seq}
          ts={item.ts}
          hideHeader={hideHeader}
          onEditAndRerun={onEditAndRerun}
          parentSessionId={parentSessionId}
          socket={socket ?? null}
          liveToolActivityTailCount={liveToolActivityTailCount}
          toolCardMode={toolCardMode}
          activeToolCallIds={activeToolCallIdSet}
          badgeIntentionCallId={badgeIntentionCallId}
          assistantRerunTarget={assistantRerunTarget}
          turnTiming={item.turnTiming}
        />
      )
    },
    [
      messageIndexByItem,
      hideHeaderByItem,
      highlightIndex,
      toolNameByCallId,
      approvalByCallId,
      onApprovalDecision,
      resultsByCallId,
      groupedCallIds,
      onEditAndRerun,
      parentSessionId,
      socket,
      onDismissCompactStatus,
      liveToolActivityTailCount,
      toolExecutionStartedAt,
      toolCardMode,
      activeToolCallIdSet,
      badgeIntentionCallId,
    ],
  )

  const keyFor = useCallback(
    (item: RenderTranscriptItem, itemIndex: number): string =>
      item.kind === 'compact_boundary'
        ? `compact-${item.seq}`
        : item.kind === 'compact_feedback'
          ? `compact-feedback-${item.status.kind}`
        : item.kind === 'tool_activity'
          ? `tool-activity-${item.group.firstCallId}`
        : transcriptItemKey(item, itemIndex),
    [],
  )

  const transcriptRef = useVirtualTranscriptScrollToken(
    scrollToBottomToken,
    transcriptItems.length,
  )

  // Uncontrolled fallback so tests / callers that don't wire the pin state
  // still work. When both props are absent we own the state locally.
  const [localPinned, setLocalPinned] = useState(true)
  const effectivePinned = pinnedToBottom ?? localPinned
  const effectiveOnPinnedChange = onPinnedChange ?? setLocalPinned
  const scrollToBottom = useCallback(() => {
    transcriptRef.current?.scrollToBottom()
    effectiveOnPinnedChange(true)
  }, [effectiveOnPinnedChange, transcriptRef])
  const displayStyle = chatDisplayStyle(displayPrefs)

  return (
    <ArtifactSessionContext.Provider value={sessionId ?? parentSessionId ?? null}>
    <WorkspaceFileLinkContext.Provider value={onOpenWorkspaceFile ?? null}>
      <OverflowReaderContext.Provider value={onReadOverflow ?? null}>
      <div className="relative flex h-full w-full min-w-0 max-w-full flex-1 flex-col overflow-x-hidden" style={displayStyle}>
        {loading ? (
          <div className="ak-chat-container mx-auto w-full py-4 sm:py-6">
            <TranscriptLoadingState />
            {footerSlot ? <div className="pl-0 pt-6 sm:pl-10">{footerSlot}</div> : null}
          </div>
        ) : isEmpty ? (
          <div className="ak-chat-container mx-auto w-full py-4 sm:py-6">
            <EmptyState onSuggest={onSuggest} />
            {footerSlot ? <div className="pl-0 pt-6 sm:pl-10">{footerSlot}</div> : null}
          </div>
        ) : (
          <VirtualTranscript<RenderTranscriptItem>
            ref={transcriptRef}
            items={transcriptItems}
            renderItem={renderItem}
            keyFor={keyFor}
            pinnedToBottom={effectivePinned}
            onPinnedChange={effectiveOnPinnedChange}
            highlightIndex={highlightItemIndex}
            footerSlot={
              footerSlot ? (
                // Align with the assistant-message content column: avatar (w-7) +
                // gap-3 = 2.5rem left inset, so the running/status/approval rows sit
                // flush under the message body above them instead of the full column.
                <div className="pl-0 pt-1 sm:pl-10">{footerSlot}</div>
              ) : null
            }
            itemClassName="ak-chat-container ak-chat-item mx-auto w-full min-w-0 overflow-x-hidden py-2 sm:py-3"
            defaultItemHeight={80}
            dataTestId="virtual-transcript"
          />
        )}
        {!isEmpty && !effectivePinned ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 z-20 h-9 w-9 rounded-full bg-background/95 text-muted-foreground shadow-lg ring-1 ring-border/70 backdrop-blur hover:text-foreground sm:bottom-5 sm:right-6"
            aria-label={t('chat.transcript.scrollToBottom')}
            title={t('chat.transcript.scrollToBottom')}
            data-testid="scroll-to-bottom"
          >
            <ChevronsDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      </OverflowReaderContext.Provider>
    </WorkspaceFileLinkContext.Provider>
    </ArtifactSessionContext.Provider>
  )
}

function previousUserRerunTarget(items: readonly RenderTranscriptItem[], beforeIndex: number): MessageRerunTarget | null {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (!item || item.kind !== 'message') continue
    if (item.message.role !== 'user') continue
    if (item.seq === undefined) return null
    const text = messagePlainText(item.message.content).trim()
    return text.length > 0 ? { seq: item.seq, text } : null
  }
  return null
}

function CompactFeedbackTranscriptRow({
  status,
  onDismiss,
}: {
  status: Exclude<CompactStatus, { kind: 'idle' }>
  onDismiss?: () => void
}): JSX.Element {
  return (
    <div className="pl-0 sm:pl-10" data-testid="compact-feedback-transcript-row">
      <CompactFeedbackRow
        kind={status.kind}
        message={status.kind === 'empty' || status.kind === 'error' ? status.message : undefined}
        startedAt={status.kind === 'running' ? status.startedAt : undefined}
        tokensBefore={status.kind === 'running' ? status.tokensBefore : undefined}
        onDismiss={status.kind === 'running' || status.kind === 'queued' ? undefined : onDismiss}
      />
    </div>
  )
}

function PendingUserMessageRow({
  item,
}: {
  item: Extract<TranscriptItem, { kind: 'pending_user_message' }>
}): JSX.Element {
  const { t } = useTranslation()
  const content = item.content ?? [{ type: 'text' as const, text: item.text }]
  const statusLabel = t('chat.transcript.sendingMessage')
  return (
    <div className="group relative flex min-w-0 max-w-full justify-end" data-testid={`pending-user-message-${item.id}`} data-status={item.status}>
      <div
        className="relative min-w-0 max-w-[92%] overflow-hidden rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground shadow-sm motion-safe:animate-[ak-pending-pulse_1.6s_ease-in-out_infinite] sm:max-w-[85%]"
        title={statusLabel}
        aria-label={statusLabel}
        data-testid={`pending-user-message-status-${item.id}`}
      >
        <InlineTimestamp
          ts={item.createdAt}
          className="absolute right-full top-1/2 mr-2 -translate-y-1/2 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-col gap-2">
          {content.map((c, i) => (
            <ContentBlock
              key={i}
              content={c}
              role="user"
              streaming={false}
              toolNameByCallId={new Map()}
              approvalByCallId={new Map()}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

type TranscriptToolActivity = {
  group: ToolCallGroup
  firstMessageIndex: number
  lastMessageIndex: number
  nextIndex: number
  before: TranscriptToolActivityMessage[]
  after: TranscriptToolActivityMessage[]
  seq?: number
  ts?: string
}

type TranscriptToolActivityMessage = {
  item: Extract<TranscriptItem, { kind: 'message' }>
  messageIndex: number
}

function collectTranscriptToolActivity(
  items: readonly TranscriptItem[],
  startIndex: number,
  previousMessageIndex: number,
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
  options: { absorbReasoning: boolean; preserveAgentCalls: boolean },
): TranscriptToolActivity | null {
  if (options.absorbReasoning) {
    return collectDotsTranscriptToolActivity(
      items,
      startIndex,
      previousMessageIndex,
      resultsByCallId,
      options.preserveAgentCalls,
    )
  }

  const start = items[startIndex]
  const startCalls = toolActivityAssistantCalls(start, false)
  if (!startCalls || startCalls.length === 0) return null

  const calls: ToolCallContent[] = []
  let i = startIndex
  let messageIndex = previousMessageIndex
  let firstMessageIndex: number | null = null
  let lastMessageIndex = previousMessageIndex
  let firstSeq: number | undefined
  let firstTs: string | undefined
  const knownCallIds = new Set<string>()

  while (i < items.length) {
    const assistantItem = items[i]
    const itemCalls = toolActivityAssistantCalls(assistantItem, false)
    if (!itemCalls || !assistantItem || assistantItem.kind !== 'message') break
    if (options.preserveAgentCalls && itemCalls.some((call) => call.name === 'agent')) break
    messageIndex += 1
    if (firstMessageIndex === null) firstMessageIndex = messageIndex
    lastMessageIndex = messageIndex
    if (firstSeq === undefined) firstSeq = assistantItem.seq
    if (firstTs === undefined) firstTs = assistantItem.ts

    for (const call of itemCalls) {
      calls.push(call)
      knownCallIds.add(call.callId)
    }
    i += 1

    while (i < items.length && isToolResultItemForKnownCalls(items[i], knownCallIds)) {
      messageIndex += 1
      lastMessageIndex = messageIndex
      i += 1
    }
  }

  if (
    calls.length === 0
    || firstMessageIndex === null
    || (!options.absorbReasoning && calls.length < 2)
  ) return null

  return {
    group: makeToolCallGroup(calls, resultsByCallId, calls.length > 1),
    firstMessageIndex,
    lastMessageIndex,
    nextIndex: i,
    before: [],
    after: [],
    ...(firstSeq !== undefined ? { seq: firstSeq } : {}),
    ...(firstTs !== undefined ? { ts: firstTs } : {}),
  }
}

function collectDotsTranscriptToolActivity(
  items: readonly TranscriptItem[],
  startIndex: number,
  previousMessageIndex: number,
  resultsByCallId: ReadonlyMap<string, ToolResultContent>,
  preserveAgentCalls: boolean,
): TranscriptToolActivity | null {
  const start = items[startIndex]
  if (!isDotsAssistantMessageWithToolCalls(start, preserveAgentCalls)) return null

  const calls: ToolCallContent[] = []
  const knownCallIds = new Set<string>()
  const before: TranscriptToolActivityMessage[] = []
  const after: TranscriptToolActivityMessage[] = []
  let foundFirstCall = false
  let i = startIndex
  let messageIndex = previousMessageIndex
  let firstMessageIndex: number | null = null
  let lastMessageIndex = previousMessageIndex
  let firstSeq: number | undefined
  let firstTs: string | undefined

  while (i < items.length) {
    const item = items[i]
    if (!item || item.kind !== 'message') break

    if (item.message.role === 'assistant') {
      if (preserveAgentCalls && item.message.content.some(
        (content) => content.type === 'tool_call' && content.name === 'agent',
      )) break

      messageIndex += 1
      lastMessageIndex = messageIndex
      const beforeContent: MessageContent[] = []
      const afterContent: MessageContent[] = []
      for (const content of item.message.content) {
        if (content.type === 'tool_call') {
          if (firstMessageIndex === null) {
            firstMessageIndex = messageIndex
            firstSeq = item.seq
            firstTs = item.ts
          }
          foundFirstCall = true
          calls.push(content)
          knownCallIds.add(content.callId)
          continue
        }
        if (content.type === 'thinking') continue
        ;(foundFirstCall ? afterContent : beforeContent).push(content)
      }
      if (beforeContent.length > 0) {
        before.push({ item: withMessageContent(item, beforeContent), messageIndex })
      }
      if (afterContent.length > 0) {
        after.push({ item: withMessageContent(item, afterContent), messageIndex })
      }
      i += 1
      continue
    }

    if (item.message.role === 'tool' && isToolResultItemForKnownCalls(item, knownCallIds)) {
      messageIndex += 1
      lastMessageIndex = messageIndex
      i += 1
      continue
    }

    break
  }

  if (calls.length === 0 || firstMessageIndex === null) return null
  return {
    group: makeToolCallGroup(calls, resultsByCallId, calls.length > 1),
    firstMessageIndex,
    lastMessageIndex,
    nextIndex: i,
    before,
    after,
    ...(firstSeq !== undefined ? { seq: firstSeq } : {}),
    ...(firstTs !== undefined ? { ts: firstTs } : {}),
  }
}

function isDotsAssistantMessageWithToolCalls(
  item: TranscriptItem | undefined,
  preserveAgentCalls: boolean,
): item is Extract<TranscriptItem, { kind: 'message' }> {
  if (!item || item.kind !== 'message' || item.message.role !== 'assistant') return false
  return item.message.content.some(
    (content) => content.type === 'tool_call' && (!preserveAgentCalls || content.name !== 'agent'),
  )
}

function withMessageContent(
  item: Extract<TranscriptItem, { kind: 'message' }>,
  content: MessageContent[],
): Extract<TranscriptItem, { kind: 'message' }> {
  return {
    ...item,
    message: { ...item.message, content },
  }
}

function toolActivityAssistantCalls(
  item: TranscriptItem | undefined,
  absorbReasoning: boolean,
): ToolCallContent[] | null {
  if (!item || item.kind !== 'message' || item.message.role !== 'assistant') return null
  if (item.message.content.length === 0) return null
  const calls: ToolCallContent[] = []
  for (const content of item.message.content) {
    if (content.type === 'tool_call') {
      calls.push(content)
      continue
    }
    if (content.type === 'text' && content.text.trim().length === 0) {
      continue
    }
    if (content.type === 'thinking' && (absorbReasoning || content.text.trim().length === 0)) {
      continue
    }
    return null
  }
  return calls
}

function isToolResultItemForKnownCalls(
  item: TranscriptItem | undefined,
  knownCallIds: ReadonlySet<string>,
): item is Extract<TranscriptItem, { kind: 'message' }> {
  if (!item || item.kind !== 'message' || item.message.role !== 'tool') return false
  if (item.message.content.length === 0) return false
  return item.message.content.every(
    (content) => content.type === 'tool_result' && knownCallIds.has(content.callId),
  )
}

function ToolActivityTranscriptRow({
  item,
  highlighted,
  hideHeader,
  approvalByCallId,
  onApprovalDecision,
  liveToolActivityTailCount,
  toolExecutionStartedAt,
  toolCardMode,
  activeToolCallIds,
  badgeIntentionCallId,
}: {
  item: Extract<RenderTranscriptItem, { kind: 'tool_activity' }>
  highlighted: boolean
  hideHeader: boolean
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  liveToolActivityTailCount: number
  toolExecutionStartedAt?: number | null
  toolCardMode: ToolCardMode
  activeToolCallIds: ReadonlySet<string> | null
  badgeIntentionCallId?: string
}): JSX.Element {
  if (toolCardMode === 'dots') {
    return (
      <div
        id={`msg-${item.firstMessageIndex}`}
        data-message-index={item.firstMessageIndex}
        className={cn(
          'group relative flex min-w-0 gap-3',
          highlighted ? 'rounded-2xl bg-amber-50/60 p-2 -mx-2 dark:bg-amber-950/20' : '',
        )}
      >
        <div className="flex w-7 flex-none items-start justify-center pt-0.5">
          {hideHeader ? (
            <GripHandle />
          ) : (
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase tracking-wider text-foreground"
              aria-label="Assistant"
            >
              AK
            </div>
          )}
        </div>
        <div className="relative min-w-0 flex-1">
          {hideHeader ? null : (
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Assistant
            </div>
          )}
          <InlineTimestamp ts={item.ts} className="absolute right-0 top-0 text-muted-foreground" />
          <ToolCallGroupBlock
            group={item.group}
            messageIndex={item.firstMessageIndex}
            approvalByCallId={approvalByCallId}
            onApprovalDecision={onApprovalDecision}
            liveToolActivityTailCount={liveToolActivityTailCount}
            toolExecutionStartedAt={toolExecutionStartedAt}
            toolCardMode={toolCardMode}
            activeToolCallIds={activeToolCallIds}
            badgeIntentionCallId={badgeIntentionCallId}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      id={`msg-${item.firstMessageIndex}`}
      data-message-index={item.firstMessageIndex}
      className={cn(
        'group relative flex min-w-0 gap-3',
        highlighted ? 'rounded-2xl bg-amber-50/60 p-2 -mx-2 dark:bg-amber-950/20' : '',
      )}
    >
      <div className="flex w-7 flex-none items-start justify-center pt-0.5">
        {hideHeader ? (
          <GripHandle />
        ) : (
          <div
            className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase tracking-wider text-foreground"
            aria-label="Assistant"
          >
            AK
          </div>
        )}
      </div>
      <div className="relative min-w-0 flex-1">
        {hideHeader ? null : (
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Assistant
          </div>
        )}
        <InlineTimestamp ts={item.ts} className="absolute right-0 top-0 text-muted-foreground" />
        <ToolCallGroupBlock
          group={item.group}
          messageIndex={item.firstMessageIndex}
          approvalByCallId={approvalByCallId}
          onApprovalDecision={onApprovalDecision}
          liveToolActivityTailCount={liveToolActivityTailCount}
          toolExecutionStartedAt={toolExecutionStartedAt}
          toolCardMode={toolCardMode}
          activeToolCallIds={activeToolCallIds}
        />
      </div>
    </div>
  )
}

function GripHandle(): JSX.Element {
  return (
    <div
      className="pointer-events-none flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
      aria-hidden="true"
    >
      <GripVertical className="h-3 w-3 text-muted-foreground/60" />
    </div>
  )
}

function InlineTimestamp({
  ts,
  className,
}: {
  ts: string | undefined
  className?: string
}): JSX.Element | null {
  if (!ts) return null
  const parsed = Date.parse(ts)
  if (!Number.isFinite(parsed)) return null
  const date = new Date(parsed)
  const label = date.toLocaleString()
  const short = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <span
      className={cn(
        'pointer-events-none select-none whitespace-nowrap font-mono text-[10px] leading-none opacity-0 transition-opacity group-hover:opacity-70',
        className,
      )}
      title={label}
    >
      {short}
    </span>
  )
}

/**
 * Bumping `scrollToBottomToken` forces the transcript to jump to the bottom
 * (e.g. after a session switch). The first non-empty mount also jumps so an
 * opened historical session starts at the latest message, not at row 0.
 * Multi-frame retries are limited to those explicit jumps because ordinary
 * appends are handled by Virtuoso's pinned followOutput path.
 */
function useVirtualTranscriptScrollToken(
  scrollToBottomToken: number | undefined,
  itemCount: number,
): React.RefObject<VirtualTranscriptHandle> {
  const ref = useRef<VirtualTranscriptHandle>(null)
  const lastToken = useRef<number | undefined>(scrollToBottomToken)
  const didInitialScroll = useRef(false)
  useEffect(() => {
    if (itemCount === 0) return
    const tokenChanged = scrollToBottomToken !== lastToken.current
    if (!tokenChanged && didInitialScroll.current) return
    didInitialScroll.current = true
    if (tokenChanged) lastToken.current = scrollToBottomToken
    const handle = ref.current
    if (!handle) return
    handle.scrollToBottom()
    // Virtuoso measures row/footer heights lazily. When a user sends a message,
    // the pending bubble and footer status can mount across several React/layout
    // turns, so repeat the explicit bottom jump longer than a single frame.
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      handle.scrollToBottom()
      raf2 = requestAnimationFrame(() => handle.scrollToBottom())
    })
    const timeouts = [
      window.setTimeout(() => handle.scrollToBottom(), 60),
      window.setTimeout(() => handle.scrollToBottom(), 180),
      window.setTimeout(() => handle.scrollToBottom(), 360),
    ]
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      for (const timeout of timeouts) window.clearTimeout(timeout)
    }
  }, [itemCount, scrollToBottomToken])
  return ref
}

function TranscriptLoadingState(): JSX.Element {
  return (
    <div className="mx-auto flex w-full flex-col gap-4 py-4 sm:py-6" data-testid="transcript-loading-state">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex min-w-0 gap-3">
          <div className="h-7 w-7 flex-none rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-20 rounded bg-muted" />
            <div className="h-16 rounded-lg bg-muted/50" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({
  onSuggest,
}: {
  onSuggest?: (text: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center gap-6 py-10 text-center sm:gap-8 sm:py-16">
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/60">
          <Sparkles className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          <Typewriter text={t('chat.transcript.emptyTitle')} charMs={38} startDelayMs={120} />
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {t('chat.transcript.emptyDescription')}
        </p>
      </div>
      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {EMPTY_SUGGESTIONS.map((s) => {
          const Icon = s.icon
          const clickable = typeof onSuggest === 'function'
          return (
            <button
              key={s.title}
              type="button"
              onClick={() => onSuggest?.(s.prompt)}
              disabled={!clickable}
              className={cn(
                'group flex min-w-0 items-start gap-3 rounded-xl bg-muted/40 p-3 text-left transition-colors sm:p-4',
                clickable
                  ? 'hover:bg-muted cursor-pointer'
                  : 'cursor-default opacity-70',
              )}
              data-testid={`empty-suggestion-${s.title.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-background text-muted-foreground group-hover:text-foreground">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-sm font-medium text-foreground">{s.title}</div>
                <div className="line-clamp-2 text-xs text-muted-foreground">{s.prompt}</div>
              </div>
            </button>
          )
        })}
      </div>
      <div className="text-xs text-muted-foreground" data-testid="empty-state-hint">
        {t('chat.transcript.empty')}
      </div>
    </div>
  )
}

type CompactTrigger = Extract<TranscriptItem, { kind: 'compact_boundary' }>['trigger']

function compactTriggerLabel(trigger: CompactTrigger, t: TFunction): string {
  switch (trigger) {
    case 'auto': return t('chat.transcript.automaticCompact')
    case 'manual': return t('chat.transcript.manualCompact')
    case 'preflight': return t('chat.transcript.preflightCompact')
    case 'tool_result': return t('chat.transcript.toolResultCompact')
    default: return t('chat.transcript.contextCompacted')
  }
}

function compactTriggerLabelShort(trigger: CompactTrigger, t: TFunction): string {
  switch (trigger) {
    case 'auto': return t('chat.transcript.automaticCompactShort')
    case 'manual': return t('chat.transcript.manualCompactShort')
    case 'preflight': return t('chat.transcript.preflightCompactShort')
    case 'tool_result': return t('chat.transcript.toolResultCompactShort')
    default: return t('chat.transcript.contextCompactedShort')
  }
}

/**
 * Format a token count for the compact-boundary label. `null` means the
 * runtime didn't emit the metadata (older sessions or in-flight upgrade);
 * render `—` rather than `0` so we don't imply the compaction was a no-op.
 */
function formatCompactTokens(value: number | null): string {
  if (value === null) return '—'
  return formatTokens(value)
}

function CompactBoundaryRow({
  boundary,
}: {
  boundary: Extract<TranscriptItem, { kind: 'compact_boundary' }>
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const trigger = compactTriggerLabel(boundary.trigger, t)
  const shortTrigger = compactTriggerLabelShort(boundary.trigger, t)
  const before = formatCompactTokens(boundary.tokensBefore)
  const after = formatCompactTokens(boundary.tokensAfter)
  return (
    <div className="flex items-center gap-3 py-2" data-testid="compact-boundary">
      <div className="h-px flex-1 bg-border/60" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-w-0 items-center gap-2 rounded-full bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="compact-boundary-open"
      >
        <Archive className="h-3 w-3 flex-none" aria-hidden="true" />
        <span className="font-medium text-foreground">{t('chat.transcript.contextCompacted')}</span>
        <span className="hidden truncate sm:inline">
          · {t('chat.transcript.compactSummary', { trigger, seq: boundary.seq, before, after, count: boundary.replacedCount })}
        </span>
        <span className="truncate sm:hidden">
          {t('chat.transcript.compactSummaryShort', { trigger: shortTrigger, before, after })}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="grid h-[82vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0 gap-0">
          <DialogHeader className="bg-card px-4 py-3">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Archive className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {t('chat.transcript.contextCompacted')}
            </DialogTitle>
            <DialogDescription>
              {t('chat.transcript.compactSummary', { trigger, seq: boundary.seq, before, after, count: boundary.replacedCount })}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 bg-background">
            <div className="px-5 py-4" data-testid="compact-summary-modal">
              <AssistantMarkdown text={boundary.summary} />
            </div>
          </ScrollArea>
          <DialogFooter className="bg-card px-4 py-3">
            <DialogClose asChild>
              <Button variant="outline" className="mt-0">{t('common.close')}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="h-px flex-1 bg-border/60" aria-hidden="true" />
    </div>
  )
}

function MessageRow({
  index,
  message,
  streaming,
  highlighted,
  toolNameByCallId,
  approvalByCallId,
  onApprovalDecision,
  resultsByCallId,
  groupedCallIds,
  seq,
  ts,
  hideHeader,
  onEditAndRerun,
  parentSessionId,
  socket,
  liveToolActivityTailCount,
  toolCardMode,
  activeToolCallIds,
  badgeIntentionCallId,
  assistantRerunTarget,
  turnTiming,
}: {
  index: number
  message: Message
  streaming: boolean
  highlighted: boolean
  toolNameByCallId: ReadonlyMap<string, string>
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  resultsByCallId: ReadonlyMap<string, ToolResultContent>
  groupedCallIds: ReadonlySet<string>
  seq?: number
  ts?: string
  hideHeader: boolean
  onEditAndRerun?: (seq: number, text: string) => void
  parentSessionId?: string
  socket?: DashboardSocket | null
  liveToolActivityTailCount: number
  toolCardMode: ToolCardMode
  activeToolCallIds: ReadonlySet<string> | null
  badgeIntentionCallId?: string
  assistantRerunTarget?: MessageRerunTarget | null
  turnTiming?: import('@agent-kernel/shared').TurnTimingSummary
}): JSX.Element | null {
  const { t } = useTranslation()
  const messageText = messagePlainText(message.content)
  const editable =
    message.role === 'user' &&
    seq !== undefined &&
    typeof onEditAndRerun === 'function'
  const initialText = editable ? messageText : ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initialText)

  if (editing && editable) {
    return (
      <div
        id={`msg-${index}`}
        data-message-index={index}
        className={cn(
          'group relative flex flex-col gap-2 rounded-2xl bg-muted/40 p-4 transition-colors',
          highlighted ? 'bg-amber-50/60 dark:bg-amber-950/20' : '',
        )}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-[80px] resize-none border-0 bg-transparent p-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          data-testid={`edit-message-input-${index}`}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-7 px-3 text-xs"
            onClick={() => {
              setEditing(false)
              setDraft(initialText)
            }}
            data-testid={`edit-message-cancel-${index}`}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            {t('chat.transcript.editCancel')}
          </Button>
          <Button
            type="button"
            className="h-7 px-3 text-xs"
            disabled={draft.trim().length === 0}
            onClick={() => {
              if (seq === undefined) return
              onEditAndRerun?.(seq, draft.trim())
              setEditing(false)
            }}
            data-testid={`edit-message-submit-${index}`}
          >
            {t('chat.transcript.rerun')}
          </Button>
        </div>
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div
        id={`msg-${index}`}
        data-message-index={index}
        className={cn(
          'group relative flex min-w-0 max-w-full justify-end gap-2',
          highlighted ? 'rounded-2xl bg-amber-50/60 p-1 dark:bg-amber-950/20' : '',
        )}
      >
        <div className="flex min-w-0 max-w-[92%] flex-col items-end gap-1.5 sm:max-w-[85%]">
          <div className="relative max-w-full overflow-hidden rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground shadow-sm">
            <InlineTimestamp
              ts={ts}
              className="absolute right-full top-1/2 mr-2 -translate-y-1/2 text-muted-foreground"
            />
            <div className="flex min-w-0 flex-col gap-2">
              {message.content.map((c, i) => (
                <ContentBlock
                  key={i}
                  content={c}
                  role={message.role}
                  streaming={false}
                  toolNameByCallId={toolNameByCallId}
                  approvalByCallId={approvalByCallId}
                  onApprovalDecision={onApprovalDecision}
                />
              ))}
            </div>
          </div>
          <MessageActions
            align="end"
            copyText={messageText}
            editAction={editable ? {
              label: t('chat.transcript.editMessage'),
              onClick: () => {
                setDraft(initialText)
                setEditing(true)
              },
              testId: `edit-message-${index}`,
            } : undefined}
          />
        </div>
        {hideHeader ? (
          <div className="flex w-4 flex-none items-center">
            <GripHandle />
          </div>
        ) : null}
      </div>
    )
  }

  // Assistant + tool messages: no bubble, avatar-labeled row with generous line height.
  const roleTextColor =
    message.role === 'tool'
      ? 'text-emerald-700 dark:text-emerald-400'
      : 'text-muted-foreground'
  const label = message.role === 'assistant' ? 'Assistant' : 'Tool result'

  const visibleContent: MessageContent[] =
    message.role === 'tool'
      ? message.content.filter(
          (c) => c.type !== 'tool_result' || !groupedCallIds.has(c.callId),
        )
      : [...message.content]

  if (visibleContent.length === 0) return null
  const assistantActions = assistantMessageActions(message, visibleContent)

  const groupedItems: GroupedContentItem[] =
    message.role === 'assistant'
      ? groupConsecutiveToolCalls(visibleContent, resultsByCallId)
      : visibleContent.map((c) => ({ kind: 'single', content: c }))

  return (
    <div
      id={`msg-${index}`}
      data-message-index={index}
      className={cn(
        'group relative flex min-w-0 gap-3',
        highlighted ? 'rounded-2xl bg-amber-50/60 p-2 -mx-2 dark:bg-amber-950/20' : '',
      )}
    >
      <div className="flex w-7 flex-none items-start justify-center pt-0.5">
        {hideHeader ? (
          <GripHandle />
        ) : (
          <div
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold uppercase tracking-wider',
              message.role === 'assistant'
                ? 'bg-muted text-foreground'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
            )}
            aria-label={label}
          >
            {message.role === 'assistant' ? 'AK' : <Wrench className="h-3 w-3" aria-hidden="true" />}
          </div>
        )}
      </div>
      <div className="relative min-w-0 max-w-full flex-1 overflow-hidden">
        {hideHeader ? null : (
          <div
            className={cn(
              'mb-1 text-[11px] font-medium uppercase tracking-wider',
              roleTextColor,
            )}
          >
            {label}
          </div>
        )}
        <InlineTimestamp ts={ts} className="absolute right-0 top-0 text-muted-foreground" />
        <div className="flex min-w-0 max-w-full flex-col gap-3 overflow-hidden">
          {groupedItems.map((item, i) => {
            if (item.kind === 'tool_call_group') {
              if (item.toolName === 'agent' && parentSessionId) {
                return (
                  <SubAgentCard
                    key={`sub-agent-${item.firstCallId}`}
                    parentSessionId={parentSessionId}
                    socket={socket ?? null}
                    group={item}
                    approvalByCallId={approvalByCallId}
                    toolCardMode={toolCardMode}
                  />
                )
              }
              return (
                <ToolCallGroupBlock
                  key={`group-${item.firstCallId}`}
                  group={item}
                  messageIndex={index}
                  approvalByCallId={approvalByCallId}
                  onApprovalDecision={onApprovalDecision}
                  liveToolActivityTailCount={liveToolActivityTailCount}
                  toolCardMode={toolCardMode}
                  activeToolCallIds={activeToolCallIds}
                  badgeIntentionCallId={badgeIntentionCallId}
                />
              )
            }
            return (
              <ContentBlock
                key={i}
                content={item.content}
                role={message.role}
                streaming={streaming}
                toolNameByCallId={toolNameByCallId}
                approvalByCallId={approvalByCallId}
                onApprovalDecision={onApprovalDecision}
              />
            )
          })}
          {message.role === 'assistant' && !streaming && turnTiming ? <TurnTimingFooter summary={turnTiming} /> : null}
          {message.role === 'assistant' && !streaming && assistantActions ? (
            <MessageActions
              align="start"
              copyText={assistantActions.copyText}
              tryAgainAction={
                !streaming && assistantRerunTarget && onEditAndRerun
                  ? {
                      label: t('chat.transcript.tryAgain'),
                      onClick: () => onEditAndRerun(assistantRerunTarget.seq, assistantRerunTarget.text),
                      testId: `try-again-message-${index}`,
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function TurnTimingFooter({ summary }: { summary: import('@agent-kernel/shared').TurnTimingSummary }): JSX.Element {
  const [open, setOpen] = useState(false)
  const statusLabel = summary.status === 'completed' ? 'Completed' : summary.status === 'failed' ? 'Failed' : summary.status === 'cancelled' ? 'Cancelled' : summary.status === 'interrupted' ? 'Interrupted' : 'Running'
  const rows = [
    ['Active work', summary.activeDurationMs], ['Approval wait', summary.approvalWaitMs],
    ['Model', summary.llm.wallDurationMs], ['Tools', summary.tools.wallDurationMs],
    ['Compaction', summary.compactionDurationMs], ['Retry', summary.retryDurationMs], ['Recovery', summary.recoveryDurationMs],
  ].filter(([, value]) => Number(value) > 0)
  return (
    <div className="max-w-xl" data-testid={`turn-timing-${summary.turnId}`}>
      <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span aria-hidden="true">{summary.status === 'completed' ? '✓' : summary.status === 'failed' ? '!' : summary.status === 'interrupted' ? '⊘' : '◌'}</span>
        <span>{statusLabel} · {formatTurnDuration(summary.wallDurationMs)}</span>
        <span className="ml-auto truncate">{summary.tools.callCount > 0 ? `${summary.tools.callCount} Tools` : ''}{summary.tools.callCount > 0 && summary.llm.requestCount > 0 ? ' · ' : ''}{summary.llm.requestCount > 0 ? `${summary.llm.requestCount} model calls` : ''}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {open ? (
        <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-[11px] sm:grid-cols-2" data-testid={`turn-timing-details-${summary.turnId}`}>
          {rows.map(([label, value]) => <div key={String(label)} className="flex justify-between gap-4"><span className="text-muted-foreground">{label}</span><span className="font-medium text-foreground">{formatTurnDuration(Number(value))}</span></div>)}
          {summary.tools.callCount > 0 ? <div className="col-span-full border-t border-border/50 pt-2 text-muted-foreground">Tool wall {formatTurnDuration(summary.tools.wallDurationMs)} · aggregate {formatTurnDuration(summary.tools.aggregateDurationMs)} · peak concurrency {summary.tools.peakConcurrency}{summary.tools.partial ? ' · partial Executor timing' : ''}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function formatTurnDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (ms > 0 && seconds === 0) return '<1s'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

function assistantMessageActions(
  message: Message,
  visibleContent: readonly MessageContent[],
): { copyText: string } | null {
  if (message.role !== 'assistant') return null
  if (visibleContent.some((content) => content.type === 'tool_call' || content.type === 'tool_result')) return null
  const text = visibleContent
    .filter((content): content is Extract<MessageContent, { type: 'text' }> => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
    .trim()
  return text.length > 0 ? { copyText: text } : null
}

function ContentBlock({
  content,
  role,
  streaming,
  toolNameByCallId,
  approvalByCallId,
  onApprovalDecision,
}: {
  content: MessageContent
  role: Message['role']
  streaming?: boolean
  toolNameByCallId: ReadonlyMap<string, string>
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
}): JSX.Element {
  if (content.type === 'text') {
    if (role === 'assistant') {
      const terminalMarker = splitAssistantTerminalMarker(content.text)
      if (terminalMarker) return <TerminalAssistantMessage text={terminalMarker.text} kind={terminalMarker.kind} />
      return <AssistantMarkdown text={content.text} streaming={streaming === true} />
    }
    if (role === 'user') {
      return (
        <div className="ak-chat-text min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {content.text}
        </div>
      )
    }
    return (
      <div className="ak-chat-text min-w-0 whitespace-pre-wrap break-words text-foreground [overflow-wrap:anywhere]">
        {content.text}
      </div>
    )
  }
  if (content.type === 'tool_call') {
    return (
      <ToolCallBlock
        call={content}
        approval={approvalByCallId.get(content.callId) ?? null}
        onApprovalDecision={onApprovalDecision}
      />
    )
  }
  if (content.type === 'tool_result') {
    return (
      <ToolResultBlock
        result={content}
        toolName={toolNameByCallId.get(content.callId)}
      />
    )
  }
  if (content.type === 'thinking') return <ThinkingBlock content={content} />
  return <ImageBlock content={content} />
}

function MessageActions({
  align,
  copyText,
  editAction,
  tryAgainAction,
}: {
  align: 'start' | 'end'
  copyText: string
  editAction?: { label: string; onClick: () => void; testId: string }
  tryAgainAction?: { label: string; onClick: () => void; testId: string }
}): JSX.Element | null {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const canCopy = copyText.trim().length > 0
  if (!canCopy && !editAction && !tryAgainAction) return null
  return (
    <div
      className={cn(
        'flex items-center gap-1 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
      data-testid={`message-actions-${align}`}
    >
      {canCopy ? (
        <button
          type="button"
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            copied && 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 hover:text-emerald-700 dark:text-emerald-400',
          )}
          title={copied ? t('common.copied') : t('common.copy')}
          aria-label={copied ? t('common.copied') : t('common.copy')}
          data-testid="copy-message"
          onClick={() => {
            void copyTextToClipboard(copyText).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            })
          }}
        >
          {copied ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      ) : null}
      {editAction ? (
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={editAction.label}
          aria-label={editAction.label}
          data-testid={editAction.testId}
          onClick={editAction.onClick}
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      {tryAgainAction ? (
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={tryAgainAction.label}
          aria-label={tryAgainAction.label}
          data-testid={tryAgainAction.testId}
          onClick={tryAgainAction.onClick}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function messagePlainText(content: readonly MessageContent[]): string {
  return content
    .map((item) => {
      if (item.type === 'text' || item.type === 'thinking') return item.text
      if (item.type === 'tool_call') return `${item.name} ${formatMessageActionValue(item.input)}`.trim()
      if (item.type === 'tool_result') return item.content
      if (item.type === 'image') return '[image]'
      return ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
}

function formatMessageActionValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function splitAssistantTerminalMarker(text: string): { text: string; kind: 'cancelled' | 'interrupted' } | null {
  const match = text.match(/(?:\n\n)?\[(cancelled|interrupted)\]\s*$/i)
  if (!match) return null
  return {
    text: text.slice(0, match.index).trimEnd(),
    kind: match[1]?.toLowerCase() === 'interrupted' ? 'interrupted' : 'cancelled',
  }
}

function TerminalAssistantMessage({ text, kind }: { text: string; kind: 'cancelled' | 'interrupted' }): JSX.Element {
  const { t } = useTranslation()
  const interrupted = kind === 'interrupted'
  return (
    <div className="min-w-0 space-y-3">
      {text.length > 0 ? <AssistantMarkdown text={text} /> : null}
      <div
        className={cn(
          'inline-flex max-w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ring-1',
          interrupted
            ? 'bg-orange-500/10 text-orange-700 ring-orange-500/25 dark:text-orange-300'
            : 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300',
        )}
        data-testid={interrupted ? 'assistant-message-interrupted' : 'assistant-message-cancelled'}
      >
        <Ban className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        <span>{interrupted ? 'Response interrupted before completion' : t('chat.transcript.cancelledMessage')}</span>
      </div>
    </div>
  )
}

function ImageBlock({
  content,
}: {
  content: import('@agent-kernel/kernel').ImageContent
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const src =
    content.source.kind === 'base64'
      ? `data:${content.source.mediaType};base64,${content.source.data}`
      : content.source.path
  const label = t('chat.transcript.openImagePreview')
  return (
    <>
      <button
        type="button"
        className="group/image relative block h-28 w-40 max-w-full cursor-zoom-in overflow-hidden rounded-lg bg-background/20 p-0.5 text-left shadow-sm transition-colors hover:bg-background/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-32 sm:w-48"
        onClick={() => setOpen(true)}
        aria-label={label}
        data-testid="message-image-preview-trigger"
      >
        <img
          src={src}
          alt=""
          className="h-full w-full rounded-md object-contain"
        />
        <span className="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-black/45 text-white opacity-0 shadow-lg transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100">
          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="h-[calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-screen max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none border-x-0 bg-black p-0 sm:h-[min(92dvh,56rem)] sm:w-[calc(100vw-2rem)] sm:max-w-[72rem] sm:rounded-lg sm:border-x"
          data-testid="message-image-preview-dialog"
        >
          <DialogHeader className="relative min-h-14 justify-center border-b border-white/10 bg-black/90 px-4 py-2 pr-14 text-white sm:py-3">
            <DialogTitle className="text-base">{t('chat.transcript.imagePreview')}</DialogTitle>
            <DialogDescription className="hidden text-white/60 sm:block">{t('chat.transcript.imagePreviewDescription')}</DialogDescription>
            <DialogClose
              className="absolute right-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              aria-label="Close image preview"
              data-testid="message-image-preview-close"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </DialogClose>
          </DialogHeader>
          <div className="flex min-h-0 min-w-0 touch-pan-x touch-pan-y items-center justify-center overflow-auto overscroll-contain bg-black p-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] sm:p-4">
            <img
              src={src}
              alt=""
              className="block max-h-full max-w-full object-contain sm:rounded-md"
              data-testid="message-image-preview-full"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ThinkingBlock({
  content,
}: {
  content: import('@agent-kernel/kernel').ThinkingContent
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-w-0 items-center gap-2 rounded-full bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted"
      >
        <Sparkles className="h-3 w-3 flex-none" />
        <span className="font-medium">{t('chat.transcript.thinking')}</span>
        {open ? (
          <ChevronDown className="h-3 w-3 flex-none" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-none" />
        )}
      </button>
      {open ? (
        <div className="ak-expand-in mt-2 rounded-lg bg-muted/30">
          <ScrollArea>
            <pre className="min-w-0 whitespace-pre-wrap break-words px-3 py-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {content.text}
            </pre>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Split streaming markdown into completed blocks (everything up to safe block
 * boundaries) plus a trailing block still being written. Rendering each
 * completed block as its own memoized component means a new token only ever
 * appends/updates the LAST block — every earlier block is byte-identical and
 * skips re-render entirely, eliminating the flicker where already-rendered
 * paragraphs/code/tables were torn down and rebuilt on every token. A boundary
 * is a blank line (`\n\n`) that is NOT inside a fenced code block.
 */
export function splitMarkdownBlocks(text: string): { blocks: readonly string[]; tail: string } {
  const boundaries: number[] = []
  let insideFence = false
  for (let i = 0; i < text.length; i += 1) {
    if ((i === 0 || text[i - 1] === '\n') && text.startsWith('```', i)) {
      insideFence = !insideFence
      continue
    }
    if (!insideFence && text[i] === '\n' && text[i + 1] === '\n') {
      boundaries.push(i + 2) // include the blank line with the completed block
    }
  }
  const blocks: string[] = []
  let start = 0
  for (const end of boundaries) {
    blocks.push(text.slice(start, end))
    start = end
  }
  return { blocks, tail: text.slice(start) }
}

/** Back-compat: previous prefix/tail split, expressed via the block split. */
export function splitStableMarkdown(text: string): { stable: string; tail: string } {
  const { blocks, tail } = splitMarkdownBlocks(text)
  return { stable: blocks.join(''), tail }
}

export const AssistantMarkdown = memo(function AssistantMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }): JSX.Element {
  const [smoothFade] = useBooleanPref(PREF_SMOOTH_STREAMING_TEXT, true)
  const { blocks, tail } = splitMarkdownBlocks(text)
  // Every logical block, including the live tail, keeps one position key for
  // its whole lifetime. When a blank line completes the tail it changes from
  // live to committed in place instead of replacing MarkdownBody/CodeBlock.
  // Replacing that subtree made already-rendered code flash as later text arrived.
  const parts = tail.length > 0 || blocks.length === 0 ? [...blocks, tail] : blocks
  return (
    <>
      {parts.map((block, index) => (
        <MarkdownBlock
          key={index}
          text={block}
          // A block ending at a blank-line boundary is already committed even
          // when it is currently the final block. Treating that block as live
          // until later text arrived changed its cursor/defer props and caused
          // ReactMarkdown to remount completed code/diagram DOM.
          streaming={streaming && tail.length > 0 && index === blocks.length}
          smoothFade={smoothFade}
        />
      ))}
    </>
  )
})

// Earlier blocks retain text/lifecycle values and skip rendering while only the
// live tail receives tokens.
const MarkdownBlock = memo(function MarkdownBlock({ text, streaming, smoothFade }: { text: string; streaming: boolean; smoothFade: boolean }): JSX.Element {
  if (streaming && smoothFade && canFadeRevealTail(text)) return <RevealTail text={text} />
  return <MarkdownBody text={text} streaming={streaming} />
})

const MarkdownBody = memo(function MarkdownBody({ text, streaming = false }: { text: string; streaming?: boolean }): JSX.Element {
  const onOpenWorkspaceFile = useContext(WorkspaceFileLinkContext)
  const artifactSessionId = useContext(ArtifactSessionContext)
  const cursorTarget = streaming ? findStreamingCursorTarget(text) : null
  const cursorEndOffset = text.trimEnd().length
  const cursor = <RevealCursor />
  // The streaming cursor is placed at the active leaf. Per-character fade is NOT
  // done here: spans nested inside ReactMarkdown remount on every token (the AST
  // is re-parsed), which restarts their CSS animation every frame — so the fade
  // was invisible and already-shown text flashed. The fade now lives in
  // <RevealTail>, a persistent sibling that ReactMarkdown never re-parses.
  const placeTextCursor = (children: React.ReactNode): React.ReactNode =>
    appendCursor(children, cursor)
  return (
    <div
      className={cn(
        'ak-chat-text min-w-0 max-w-full overflow-hidden break-words text-foreground [overflow-wrap:anywhere]',
        streaming && 'ak-streaming-markdown',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4',
        '[&_p]:my-3',
        '[&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-base [&_h1]:font-semibold',
        '[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-sm [&_h2]:font-semibold',
        '[&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold',
        '[&_h4]:mb-1.5 [&_h4]:mt-4 [&_h4]:text-sm [&_h4]:font-semibold',
        '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border/60 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-foreground [&_code]:[overflow-wrap:anywhere] [&_code]:[word-break:break-word]',
        '[&_img]:h-auto [&_img]:max-h-64 [&_img]:max-w-full [&_img]:rounded-lg sm:[&_img]:max-w-xs',
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_li]:my-1 [&_li>p]:my-1',
        '[&_li_ul]:my-1 [&_li_ol]:my-1',
        '[&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:bg-transparent [&_pre]:p-0',
        '[&_pre_code]:block [&_pre_code]:min-w-max [&_pre_code]:bg-transparent [&_pre_code]:p-3 [&_pre_code]:text-foreground',
        '[&_hr]:my-4 [&_hr]:border-border/50',
        '[&_table]:my-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:ring-1 [&_table]:ring-border/50 [&_td]:px-2 [&_th]:px-2',
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={(url) => url.startsWith('artifact://') ? url : url}
        components={{
          img({ src, alt }) {
            const match = typeof src === 'string' ? src.match(/^artifact:\/\/([^/?#]+)/) : null
            if (match && artifactSessionId) {
              const resolved = `/session-artifacts/${encodeURIComponent(match[1]!)}?sessionId=${encodeURIComponent(artifactSessionId)}`
              return <ArtifactMarkdownImage src={resolved} alt={alt ?? 'artifact image'} />
            }
            return <img src={src} alt={alt ?? ''} />
          },
          pre({ children, node: _node }) {
            const trailingSlot = shouldPlaceStreamingCursor(cursorTarget, 'code', _node, cursorEndOffset) ? cursor : undefined
            return <MarkdownPre trailingSlot={trailingSlot}>{children}</MarkdownPre>
          },
          code({ inline, className, children, node: _node, ...rest }: {
            inline?: boolean
            className?: string
            children?: React.ReactNode
            node?: MarkdownNodeWithPosition
          }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'code', _node, cursorEndOffset) ? appendCursor(children, cursor) : children
            return (
              <code className={className} {...rest}>
                {withCursor}
              </code>
            )
          },
          p({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'p', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <p {...rest}>{withCursor}</p>
          },
          li({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'li', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <li {...rest}>{withCursor}</li>
          },
          h1({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'h1', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <h1 {...rest}>{withCursor}</h1>
          },
          h2({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'h2', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <h2 {...rest}>{withCursor}</h2>
          },
          h3({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'h3', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <h3 {...rest}>{withCursor}</h3>
          },
          h4({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'h4', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <h4 {...rest}>{withCursor}</h4>
          },
          td({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'td', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <td {...rest}>{withCursor}</td>
          },
          th({ children, node: _node, ...rest }) {
            const withCursor = shouldPlaceStreamingCursor(cursorTarget, 'th', _node, cursorEndOffset) ? placeTextCursor(children) : children
            return <th {...rest}>{withCursor}</th>
          },
          a({ href, children, ...rest }) {
            const fileTarget = href ? workspaceFileTargetFromHref(href) : null
            if (!fileTarget || !onOpenWorkspaceFile) {
              return <a href={href} {...rest}>{children}</a>
            }
            const label = reactNodeText(children).trim() || fileTarget.path
            const Icon = workspaceFileIcon(fileTarget.path)
            const title = fileTarget.line !== undefined
              ? `View file: ${fileTarget.path}:${fileTarget.line}${fileTarget.column !== undefined ? `:${fileTarget.column}` : ''}`
              : `View file: ${fileTarget.path}`
            return (
              <a
                href={href}
                {...rest}
                className="not-prose inline-flex max-w-full items-center gap-1 rounded border border-border/70 bg-muted/50 px-1.5 py-0.5 align-baseline font-mono text-[0.85em] leading-snug text-foreground no-underline shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={title}
                aria-label={title}
                data-testid="workspace-file-link"
                onClick={(event) => {
                  event.preventDefault()
                  onOpenWorkspaceFile(fileTarget)
                }}
              >
                <Icon className="h-3 w-3 flex-none text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 truncate">{label}</span>
              </a>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

function ArtifactMarkdownImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="text-sm text-destructive" role="alert">Image unavailable: {alt}</span>
  return (
    <>
      <button type="button" className="block max-w-full cursor-zoom-in" onClick={() => setOpen(true)} aria-label={`Open image preview: ${alt}`} data-testid="artifact-markdown-image">
        <img src={src} alt={alt} onError={() => setFailed(true)} loading="lazy" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="h-[calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top))] w-screen max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none border-x-0 bg-black p-0 pb-[env(safe-area-inset-bottom)] sm:h-[min(92dvh,56rem)] sm:w-[calc(100vw-2rem)] sm:max-w-6xl sm:rounded-lg sm:border-x sm:pb-0" data-testid="artifact-image-preview-dialog">
          <DialogHeader className="relative min-h-14 justify-center border-b border-white/10 bg-black/90 px-4 py-2 pr-14 text-white">
            <DialogTitle className="truncate text-sm sm:text-base">{alt}</DialogTitle>
            <DialogClose className="absolute right-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70" aria-label="Close image preview" data-testid="artifact-image-preview-close">
              <X className="h-5 w-5" aria-hidden="true" />
            </DialogClose>
          </DialogHeader>
          <div className="flex min-h-0 min-w-0 touch-pan-x touch-pan-y items-center justify-center overflow-auto overscroll-contain bg-black p-2 sm:p-4">
            <img src={src} alt={alt} className="block max-h-full max-w-full object-contain" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

type StreamingCursorTarget = 'p' | 'li' | 'code' | 'h1' | 'h2' | 'h3' | 'h4' | 'td' | 'th'

function appendCursor(children: React.ReactNode, cursor: JSX.Element): React.ReactNode {
  return <>{children}{cursor}</>
}

type MarkdownNodeWithPosition = {
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

function shouldPlaceStreamingCursor(
  target: StreamingCursorTarget | null,
  tag: StreamingCursorTarget,
  node: MarkdownNodeWithPosition | undefined,
  cursorEndOffset: number,
): boolean {
  if (target !== tag) return false
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number') return false
  return start <= cursorEndOffset && cursorEndOffset <= end
}

function findStreamingCursorTarget(text: string): StreamingCursorTarget {
  const trimmed = text.trimEnd()
  const lastLine = trimmed.split('\n').at(-1)?.trimEnd() ?? ''
  const tableLine = findLastMeaningfulLine(trimmed)

  if (isInsideTrailingFence(trimmed)) return 'code'
  if (/^####\s+\S/.test(lastLine)) return 'h4'
  if (/^###\s+\S/.test(lastLine)) return 'h3'
  if (/^##\s+\S/.test(lastLine)) return 'h2'
  if (/^#\s+\S/.test(lastLine)) return 'h1'
  if (/^(?:[-+*]|\d+[.)])\s+\S/.test(lastLine)) return 'li'
  if (/^\|.*\|\s*$/.test(tableLine) && !/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tableLine)) {
    return 'td'
  }
  return 'p'
}

function findLastMeaningfulLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trimEnd() ?? ''
    if (line.trim().length > 0) return line
  }
  return ''
}

function isInsideTrailingFence(text: string): boolean {
  const fenceCount = text
    .split('\n')
    .filter((line) => /^\s*```/.test(line) || /^\s*~~~/.test(line))
    .length
  return fenceCount % 2 === 1
}

function workspaceFileTargetFromHref(href: string): WorkspaceFileTarget | null {
  const trimmed = safeDecodeUri(href).trim()
  if (trimmed.length === 0) return null
  if (/^(?:https?|mailto|data|blob|tel):/i.test(trimmed) || trimmed.startsWith('#')) return null
  const fileHref = /^file:\/\//i.test(trimmed) ? trimmed.replace(/^file:\/\//i, '') : trimmed
  const parsed = splitFileTarget(fileHref)
  if (!parsed.path) return null
  if (parsed.path.startsWith('/') || parsed.path.startsWith('./') || parsed.path.startsWith('../')) return parsed
  if (!parsed.path.includes('/')) return null
  if (/\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(parsed.path)) return parsed
  return null
}

function splitFileTarget(value: string): WorkspaceFileTarget {
  const match = value.match(/^(.*?)(?::(\d+))(?::(\d+))?$/)
  if (!match) return { path: value }
  const path = match[1] ?? value
  if (!/\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(path)) return { path: value }
  const line = Number(match[2])
  const column = match[3] !== undefined ? Number(match[3]) : undefined
  return {
    path,
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    ...(column !== undefined && Number.isInteger(column) && column > 0 ? { column } : {}),
  }
}

function workspaceFileIcon(path: string): typeof FileText {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return Image
  if (ext && ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'html', 'py', 'rs', 'go', 'java', 'sh', 'bash'].includes(ext)) return Code2
  return FileText
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function MarkdownPre({ children, trailingSlot }: { children?: React.ReactNode; trailingSlot?: React.ReactNode }): JSX.Element {
  const code = Children.toArray(children).find((child) => isValidElement(child))
  if (code && isValidElement<{ className?: string; children?: React.ReactNode }>(code)) {
    const className = code.props.className
    const match = /language-(\w+)/.exec(className ?? '')
    const raw = reactNodeText(code.props.children).replace(/\n$/, '')
    const lang = match?.[1]?.toLowerCase()
    if (lang === 'mermaid') return <MermaidBlock code={raw} deferRender={Boolean(trailingSlot)} />
    return <CodeBlock code={raw} lang={lang} trailingSlot={trailingSlot} deferEnhancement={Boolean(trailingSlot)} />
  }
  return <CodeBlock code={reactNodeText(children).replace(/\n$/, '')} trailingSlot={trailingSlot} deferEnhancement={Boolean(trailingSlot)} />
}

function reactNodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeText).join('')
  if (isValidElement<{ children?: React.ReactNode }>(node)) return reactNodeText(node.props.children)
  return ''
}

function ToolCallBlock({
  call,
  approval,
  onApprovalDecision,
}: {
  call: ToolCallContent
  approval: ApprovalRequiredEvent | null
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
}): JSX.Element {
  const { t } = useTranslation()
  const isPendingApproval = approval !== null && typeof onApprovalDecision === 'function'
  const hasDiffPreview = isPendingApproval && hasDiffPreviewForTool(call.name)
  const [open, setOpen] = useState(false)
  return (
    <div
      className={cn(
        'min-w-0 max-w-full overflow-hidden rounded-lg transition-colors',
        isPendingApproval
          ? 'bg-amber-50/60 ring-1 ring-amber-400/60 dark:bg-amber-950/20 dark:ring-amber-500/40'
          : 'bg-muted/40',
      )}
      data-testid={
        isPendingApproval ? `tool-call-pending-${call.callId}` : undefined
      }
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'group/tool flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground transition-colors',
          isPendingApproval
            ? 'hover:bg-amber-100/40 dark:hover:bg-amber-950/30'
            : 'hover:bg-muted',
        )}
        data-testid={`tool-call-toggle-${call.callId}`}
      >
        <Wrench
          className={cn(
            'h-3.5 w-3.5 flex-none',
            isPendingApproval
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground',
          )}
        />
        <span
          className={cn(
            'font-medium',
            isPendingApproval
              ? 'text-amber-800 dark:text-amber-200'
              : 'text-muted-foreground',
          )}
        >
          {isPendingApproval ? t('chat.transcript.approvalNeeded') : t('chat.transcript.assistantRequestedTool')}
        </span>
        <span className="min-w-0 max-w-[45%] truncate rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px]">
          {call.name}
        </span>
        <span className="flex-1" />
        <span className="hidden max-w-[35%] truncate font-mono text-[11px] text-muted-foreground sm:inline">
          {call.callId}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="ak-expand-in flex min-w-0 flex-col gap-2 px-3 pb-2">
          {isPendingApproval && hasDiffPreview ? (
            <DiffPreview toolName={call.name} input={approval.input} />
          ) : (
            <div className="overflow-hidden rounded-md bg-background/60">
              <ScrollArea>
                <pre className="min-w-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                  {JSON.stringify(call.input, null, 2)}
                </pre>
              </ScrollArea>
            </div>
          )}
          {isPendingApproval ? (
            <p className="pt-1 text-[11px] italic text-amber-700 dark:text-amber-300">
              {t('chat.transcript.approveRejectBelow')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ToolResultBlock({
  result,
  toolName,
  defaultOpen = false,
}: {
  result: ToolResultContent
  toolName?: string
  defaultOpen?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  const overflowReader = useContext(OverflowReaderContext)
  const isOverflowed = detectOverflowMarker(result.content)
  const [fullOutput, setFullOutput] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'loaded'; content: string } | { state: 'error'; error: string }
  >({ state: 'idle' })
  const Icon = result.ok ? CheckCircle2 : XCircle
  const statusTone = result.ok
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400'
  const statusBadge = result.ok
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'

  const handleViewFull = async (): Promise<void> => {
    if (!overflowReader || fullOutput.state === 'loading') return
    setFullOutput({ state: 'loading' })
    const res = await overflowReader(result.callId)
    if (res.error) setFullOutput({ state: 'error', error: res.error })
    else setFullOutput({ state: 'loaded', content: res.content ?? '' })
  }

  const displayContent =
    fullOutput.state === 'loaded' ? fullOutput.content : result.content
  const displayOutput = parseToolResultDisplay(displayContent)

  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group/tool flex w-full min-w-0 items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
        data-testid={`tool-result-toggle-${result.callId}`}
      >
        <Icon className={cn('h-3.5 w-3.5 flex-none', statusTone)} />
        <span className="font-medium text-muted-foreground">{t('chat.transcript.toolResult')}</span>
        {toolName ? (
          <span className="min-w-0 max-w-[45%] truncate rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px]">
            {toolName}
          </span>
        ) : null}
        <span
          className={cn(
            'flex-none rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider',
            statusBadge,
          )}
        >
          {result.ok ? t('chat.transcript.succeeded') : t('chat.transcript.failed')}
        </span>
        {isOverflowed ? (
          <span className="flex-none rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {t('chat.transcript.truncated')}
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="hidden max-w-[35%] truncate font-mono text-[11px] text-muted-foreground sm:inline">
          {result.callId}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="ak-expand-in mt-2 overflow-hidden rounded-lg bg-muted/60">
          {isOverflowed && fullOutput.state !== 'loaded' && overflowReader ? (
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5 text-[11px]">
              <span className="text-muted-foreground">
                Output truncated inline; full text lives on the executor's disk.
              </span>
              <button
                type="button"
                onClick={() => {
                  void handleViewFull()
                }}
                disabled={fullOutput.state === 'loading'}
                className="rounded bg-primary/10 px-2 py-0.5 font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
              >
                {fullOutput.state === 'loading' ? 'Loading…' : 'View full output'}
              </button>
            </div>
          ) : null}
          {fullOutput.state === 'error' ? (
            <div className="border-b border-border/40 bg-rose-50/60 px-3 py-1.5 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              Failed to read full output: {fullOutput.error}
            </div>
          ) : null}
          <ToolResultContentView
            content={displayOutput.content}
            rawClassName="px-3 py-2"
          />
          {displayOutput.metadata ? (
            <ToolResultMetadataFields metadata={displayOutput.metadata} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

type ToolResultDisplayMetadata = {
  exitCode: string
  duration: string
}

type ToolResultDisplay = {
  content: string
  metadata: ToolResultDisplayMetadata | null
}

const TOOL_RESULT_METADATA_RE = /(?:^|\n)--- exit code: ([^,\n]+), duration: ([^\n]+)\s*$/

function parseToolResultDisplay(content: string): ToolResultDisplay {
  const match = TOOL_RESULT_METADATA_RE.exec(content)
  if (!match) return { content, metadata: null }
  return {
    content: content.slice(0, match.index).replace(/\n$/, ''),
    metadata: { exitCode: match[1]!.trim(), duration: match[2]!.trim() },
  }
}

function parseToolError(content: string): { code?: string; message: string } | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  const withoutPrefix = trimmed.replace(/^ERROR:\s*/i, '')
  const parts = withoutPrefix.split(':').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const first = parts[0]
  const second = parts[1]
  const code = first && /^[A-Z][A-Z0-9_]+$/.test(first) ? first : undefined
  if (!code) return { message: withoutPrefix }
  const messageParts = second === code ? parts.slice(2) : parts.slice(1)
  const message = messageParts.join(': ') || withoutPrefix.replace(new RegExp(`^${code}:\\s*`), '')
  return { code, message: message || withoutPrefix }
}

type StructuredToolResultFile = {
  path?: string
  operation?: string
  additions?: number
  deletions?: number
  diff?: string
  bytes_before?: number
  bytes_after?: number
  replacements?: Array<{ index?: number; count?: number }>
}

type StructuredToolResult = {
  ok?: boolean
  summary?: string
  files?: StructuredToolResultFile[]
}

function parseStructuredToolResult(content: string): StructuredToolResult | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const files = Array.isArray(record.files)
      ? record.files.map(normalizeStructuredToolResultFile).filter((file): file is StructuredToolResultFile => file !== null)
      : []
    const hasRenderableFields =
      typeof record.summary === 'string' ||
      files.length > 0
    if (!hasRenderableFields) return null
    return {
      ...(typeof record.ok === 'boolean' ? { ok: record.ok } : {}),
      ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
      ...(files.length > 0 ? { files } : {}),
    }
  } catch {
    return null
  }
}

function normalizeStructuredToolResultFile(value: unknown): StructuredToolResultFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const replacements = Array.isArray(record.replacements)
    ? record.replacements.map(normalizeReplacement).filter((item): item is { index?: number; count?: number } => item !== null)
    : undefined
  const file: StructuredToolResultFile = {
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
    ...(typeof record.operation === 'string' ? { operation: record.operation } : {}),
    ...(isFiniteNumber(record.additions) ? { additions: record.additions } : {}),
    ...(isFiniteNumber(record.deletions) ? { deletions: record.deletions } : {}),
    ...(typeof record.diff === 'string' ? { diff: record.diff } : {}),
    ...(isFiniteNumber(record.bytes_before) ? { bytes_before: record.bytes_before } : {}),
    ...(isFiniteNumber(record.bytes_after) ? { bytes_after: record.bytes_after } : {}),
    ...(replacements && replacements.length > 0 ? { replacements } : {}),
  }
  return Object.keys(file).length > 0 ? file : null
}

function normalizeReplacement(value: unknown): { index?: number; count?: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const replacement = {
    ...(isFiniteNumber(record.index) ? { index: record.index } : {}),
    ...(isFiniteNumber(record.count) ? { count: record.count } : {}),
  }
  return Object.keys(replacement).length > 0 ? replacement : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function ToolResultContentView({
  content,
  fallback,
  rawClassName,
}: {
  content: string
  fallback?: string
  rawClassName?: string
}): JSX.Element {
  const [raw, setRaw] = useState(false)
  const structuredResult = parseStructuredToolResult(content)
  if (!structuredResult) {
    return (
      <ScrollArea>
        <pre className={cn('min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]', rawClassName ?? 'px-2.5 py-2')}>
          {fallback || content || '(no output)'}
        </pre>
      </ScrollArea>
    )
  }
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 border-b border-border/30 px-2.5 py-1.5 text-[11px]">
        <span className="text-muted-foreground">Result</span>
        <button
          type="button"
          onClick={() => setRaw((value) => !value)}
          className="rounded bg-muted px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
        >
          {raw ? 'Rendered result' : 'Raw result'}
        </button>
      </div>
      {raw ? (
        <ScrollArea>
          <pre className={cn('min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]', rawClassName ?? 'px-2.5 py-2')}>
            {content || '(no output)'}
          </pre>
        </ScrollArea>
      ) : (
        <StructuredToolResultView result={structuredResult} />
      )}
    </div>
  )
}

function StructuredToolResultView({ result }: { result: StructuredToolResult }): JSX.Element {
  const files = result.files ?? []
  return (
    <div className="space-y-2 px-2.5 py-2 text-[11px]">
      {result.summary ? <div className="leading-relaxed text-foreground">{result.summary}</div> : null}
      {files.length > 0 ? (
        <div className="space-y-2">
          {files.map((file, index) => (
            <StructuredToolResultFileView key={`${file.path ?? 'file'}-${index}`} file={file} />
          ))}
        </div>
      ) : null}
      {!result.summary && files.length === 0 ? <div className="text-muted-foreground">(no output)</div> : null}
    </div>
  )
}

function StructuredToolResultFileView({ file }: { file: StructuredToolResultFile }): JSX.Element {
  const metric = typeof file.additions === 'number' || typeof file.deletions === 'number'
    ? { kind: 'delta' as const, additions: file.additions ?? 0, deletions: file.deletions ?? 0 }
    : null
  const replacementCount = file.replacements?.reduce((sum, item) => sum + (item.count ?? 0), 0)
  return (
    <div className="overflow-hidden rounded border border-border/40 bg-background/50">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/30 px-2 py-1.5">
        {file.operation ? <ToolTextBadge tone={operationTone(file.operation)}>{file.operation}</ToolTextBadge> : null}
        {metric ? <ToolDeltaBadges metric={metric} /> : null}
        {typeof replacementCount === 'number' && replacementCount > 0 ? <ToolTextBadge>{replacementCount} replacement{replacementCount === 1 ? '' : 's'}</ToolTextBadge> : null}
        {typeof file.bytes_before === 'number' && typeof file.bytes_after === 'number' ? (
          <ToolTextBadge>{formatBytes(file.bytes_before)} to {formatBytes(file.bytes_after)}</ToolTextBadge>
        ) : null}
        <span className="min-w-[8rem] flex-1 truncate font-mono text-foreground" title={file.path}>{file.path ?? '(no path)'}</span>
      </div>
      {file.diff ? <ToolResultDiffView diff={file.diff} /> : null}
    </div>
  )
}

function operationTone(operation: string): 'neutral' | 'success' | 'danger' | 'warning' | 'primary' {
  if (operation === 'created' || operation === 'added') return 'success'
  if (operation === 'deleted' || operation === 'removed') return 'danger'
  if (operation === 'modified' || operation === 'updated') return 'warning'
  return 'neutral'
}

function ToolResultDiffView({ diff }: { diff: string }): JSX.Element {
  const lines = diff.split('\n')
  return (
    <ScrollArea className="max-h-96 max-w-full">
      <pre className="min-w-max whitespace-pre py-1 pr-2 font-mono text-[11px] leading-snug">
        {lines.map((line, index) => (
          <span key={index} className={cn('block px-2', resultDiffLineClass(line))}>{line || ' '}</span>
        ))}
      </pre>
    </ScrollArea>
  )
}

function resultDiffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
  if (line.startsWith('@@')) return 'bg-muted text-muted-foreground'
  if (line.startsWith('---') || line.startsWith('+++')) return 'bg-muted/50 text-muted-foreground'
  return 'text-foreground dark:text-muted-foreground'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function ToolResultMetadataFields({
  metadata,
  compact = false,
}: {
  metadata: ToolResultDisplayMetadata
  compact?: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground',
        compact ? '' : 'border-t border-border/40 px-3 py-1.5',
      )}
    >
      <span className="inline-flex h-5 items-center gap-1 rounded bg-background/70 px-1.5 leading-none">
        <span className="uppercase tracking-wider text-muted-foreground/70">exit</span>
        <span className="font-mono text-foreground">{metadata.exitCode}</span>
      </span>
      <span className="inline-flex h-5 items-center gap-1 rounded bg-background/70 px-1.5 leading-none">
        <span className="uppercase tracking-wider text-muted-foreground/70">duration</span>
        <span className="font-mono text-foreground">{metadata.duration}</span>
      </span>
    </div>
  )
}

function ToolTextBadge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'success' | 'danger' | 'warning' | 'primary'
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 flex-none items-center rounded px-1.5 text-[10px] font-medium uppercase leading-none tracking-wider',
        tone === 'success' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
        tone === 'danger' && 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
        tone === 'warning' && 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
        tone === 'primary' && 'bg-primary text-primary-foreground',
        tone === 'neutral' && 'bg-background/80 text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

function ToolDeltaBadges({ metric }: { metric: SummaryDelta | null }): JSX.Element | null {
  if (!metric) return null
  return (
    <span className="inline-flex h-5 flex-none items-center overflow-hidden rounded border border-border/50 bg-background/70 text-[11px] leading-none shadow-sm" aria-label={`${metric.additions} additions, ${metric.deletions} deletions`}>
      <span className="inline-flex h-5 items-center gap-1 border-r border-border/50 px-1.5 font-mono font-semibold text-emerald-700 dark:text-emerald-300">
        <span className="text-[10px] text-emerald-600/80 dark:text-emerald-300/80">+</span>
        {metric.additions}
      </span>
      <span className="inline-flex h-5 items-center gap-1 px-1.5 font-mono font-semibold text-rose-700 dark:text-rose-300">
        <span className="text-[10px] text-rose-600/80 dark:text-rose-300/80">-</span>
        {metric.deletions}
      </span>
    </span>
  )
}

function ToolNameChip({ name }: { name: string }): JSX.Element {
  return (
    <span className="inline-flex h-5 max-w-[45%] flex-none items-center rounded bg-background/85 px-1.5 font-mono text-[11px] leading-none text-foreground ring-1 ring-border/50" title={name}>
      <span className="truncate">{name}</span>
    </span>
  )
}

function ToolCallInlineDetail({
  call,
  approval,
  onApprovalDecision,
  compactNarrative = false,
}: {
  call: ToolCallContent
  approval: ApprovalRequiredEvent | null
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  compactNarrative?: boolean
}): JSX.Element {
  const isPendingApproval = approval !== null && typeof onApprovalDecision === 'function'
  const hasDiffPreview = isPendingApproval && hasDiffPreviewForTool(call.name)
  const summary = summarizeToolCallInput(call)
  return (
    <div
      className="min-w-0 overflow-hidden rounded-md border border-border/40 bg-background/40"
      data-testid={isPendingApproval ? `tool-call-pending-${call.callId}` : undefined}
    >
      {!compactNarrative ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/30 px-2.5 py-1.5 text-[11px]">
          <ToolTextBadge>request</ToolTextBadge>
          <span className="min-w-0 truncate font-mono text-foreground">{call.name}</span>
          {isPendingApproval ? (
            <ToolTextBadge tone="warning">Approval needed</ToolTextBadge>
          ) : null}
        </div>
      ) : null}
      {call.intent ? (
        <p className="border-b border-border/30 px-2.5 py-2 text-[12px] leading-relaxed text-foreground whitespace-pre-wrap break-words" data-testid={`tool-call-detail-intent-${call.callId}`}>
          {call.intent}
        </p>
      ) : null}
      <details className="border-b border-border/30 text-[11px]" data-testid={`tool-call-technical-details-${call.callId}`}>
        <summary className="cursor-pointer select-none px-2.5 py-1.5 font-medium text-muted-foreground hover:text-foreground">Technical details</summary>
        <div className="border-t border-border/30">
          {summary ? <div className="flex flex-wrap gap-1.5 px-2.5 py-2"><ToolCallInputFieldBadges fields={summary.fields} /></div> : null}
          {isPendingApproval && hasDiffPreview ? (
            <div className="p-2">
              <DiffPreview toolName={call.name} input={approval.input} />
            </div>
          ) : summary?.rows?.length ? (
            <ToolCallInputSummaryRows rows={summary.rows} />
          ) : (
            <ScrollArea>
              <pre className="min-w-0 whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {JSON.stringify(call.input, null, 2)}
              </pre>
            </ScrollArea>
          )}
        </div>
      </details>
      {isPendingApproval ? (
        <p className="border-t border-border/30 px-2.5 py-1.5 text-[11px] italic text-amber-700 dark:text-amber-300">
          Approve or reject below.
        </p>
      ) : null}
    </div>
  )
}

type ToolCallInputSummary = {
  fields: Array<{ label: string; value: string }>
  rows?: string[]
}

function summarizeToolCallInput(call: ToolCallContent): ToolCallInputSummary | null {
  const path = inputString(call.input.path ?? call.input.file_path)
  if (call.name === 'replace_many_in_file') {
    const edits = Array.isArray(call.input.edits) ? call.input.edits : []
    return {
      fields: [
        ...(path ? [{ label: 'path', value: path }] : []),
        { label: 'edits', value: String(edits.length) },
      ],
      rows: edits.slice(0, 3).map((edit, index) => {
        const record = edit && typeof edit === 'object' && !Array.isArray(edit) ? edit as Record<string, unknown> : {}
        const oldText = truncate(firstLine(inputString(record.old_string)), 56)
        const newText = truncate(firstLine(inputString(record.new_string)), 56)
        const suffix = record.replace_all === true ? ' · all' : ''
        return `${index + 1}. ${oldText || '(empty)'} -> ${newText || '(empty)'}${suffix}`
      }),
    }
  }
  if (call.name === 'replace_in_file') {
    return {
      fields: [
        ...(path ? [{ label: 'path', value: path }] : []),
        ...(call.input.replace_all === true ? [{ label: 'mode', value: 'replace all' }] : []),
      ],
      rows: [`${truncate(firstLine(inputString(call.input.old_string)), 72) || '(empty)'} -> ${truncate(firstLine(inputString(call.input.new_string)), 72) || '(empty)'}`],
    }
  }
  if (call.name === 'write_file') {
    const content = inputString(call.input.content)
    return {
      fields: [
        ...(path ? [{ label: 'path', value: path }] : []),
        { label: 'lines', value: String(content ? countDisplayLines(content) : 0) },
      ],
    }
  }
  return null
}

function ToolCallInputFieldBadges({ fields }: { fields: ToolCallInputSummary['fields'] }): JSX.Element | null {
  if (fields.length === 0) return null
  return (
    <>
      {fields.map((field) => (
        <span key={field.label} className="inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded bg-muted/70 px-1.5 leading-none">
          <span className="flex-none uppercase tracking-wider text-muted-foreground/70">{field.label}</span>
          <span className="min-w-0 truncate font-mono text-foreground">{field.value}</span>
        </span>
      ))}
    </>
  )
}

function ToolCallInputSummaryRows({ rows }: { rows: string[] }): JSX.Element {
  return (
    <div className="px-2.5 py-2 text-[11px]">
      <div className="min-w-0 rounded bg-muted/40 px-2 py-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {rows.map((row) => (
          <div key={row} className="truncate">{row}</div>
        ))}
      </div>
    </div>
  )
}

function inputString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function countDisplayLines(value: string): number {
  if (value.length === 0) return 0
  return value.split('\n').length
}

function ToolResultInlineDetail({
  result,
  compactNarrative = false,
}: {
  result: ToolResultContent
  compactNarrative?: boolean
}): JSX.Element {
  const overflowReader = useContext(OverflowReaderContext)
  const isOverflowed = detectOverflowMarker(result.content)
  const [fullOutput, setFullOutput] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'loaded'; content: string } | { state: 'error'; error: string }
  >({ state: 'idle' })
  const displayContent = fullOutput.state === 'loaded' ? fullOutput.content : result.content
  const displayOutput = parseToolResultDisplay(displayContent)
  const parsedError = result.ok ? null : parseToolError(displayOutput.content)

  const handleViewFull = async (): Promise<void> => {
    if (!overflowReader || fullOutput.state === 'loading') return
    setFullOutput({ state: 'loading' })
    const res = await overflowReader(result.callId)
    if (res.error) setFullOutput({ state: 'error', error: res.error })
    else setFullOutput({ state: 'loaded', content: res.content ?? '' })
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-border/40 bg-background/40">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/30 px-2.5 py-1.5 text-[11px]">
        <ToolTextBadge tone={compactNarrative ? 'neutral' : result.ok ? 'success' : 'danger'}>{compactNarrative ? 'result' : result.ok ? 'succeeded' : 'failed'}</ToolTextBadge>
        {parsedError?.code ? <ToolTextBadge tone="danger">{parsedError.code}</ToolTextBadge> : null}
        {displayOutput.metadata ? <ToolResultMetadataFields metadata={displayOutput.metadata} compact /> : null}
        {isOverflowed ? (
          <ToolTextBadge tone="warning">truncated</ToolTextBadge>
        ) : null}
      </div>
      {isOverflowed && fullOutput.state !== 'loaded' && overflowReader ? (
        <div className="flex items-center justify-between border-b border-border/30 px-2.5 py-1.5 text-[11px]">
          <span className="text-muted-foreground">Output truncated inline.</span>
          <button
            type="button"
            onClick={() => {
              void handleViewFull()
            }}
            disabled={fullOutput.state === 'loading'}
            className="rounded bg-primary/10 px-2 py-0.5 font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
          >
            {fullOutput.state === 'loading' ? 'Loading…' : 'View full output'}
          </button>
        </div>
      ) : null}
      {fullOutput.state === 'error' ? (
        <div className="border-b border-border/30 bg-rose-50/60 px-2.5 py-1.5 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          Failed to read full output: {fullOutput.error}
        </div>
      ) : null}
      <ToolResultContentView
        content={displayOutput.content}
        fallback={parsedError?.message}
      />
    </div>
  )
}

function summarizeToolResultInline(content: string): string {
  const parsed = parseToolResultDisplay(content)
  const text = parsed.content.trim()
  if (text) return summarizeStructuredToolResult(text) ?? truncate(firstLine(text), 72)
  if (parsed.metadata) return `exit ${parsed.metadata.exitCode} · ${parsed.metadata.duration}`
  return '(no output)'
}

type ToolHeaderResultSummary =
  | { kind: 'none' }
  | { kind: 'delta'; metric: SummaryDelta }
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'error'; code?: string; message: string }

function summarizeToolResultForHeader(
  call: ToolCallContent,
  row: SummaryRow | null,
  result: ToolResultContent,
): ToolHeaderResultSummary {
  if (!result.ok) {
    const parsed = parseToolError(parseToolResultDisplay(result.content).content)
    return parsed
      ? { kind: 'error', ...(parsed.code ? { code: parsed.code } : {}), message: parsed.message }
      : { kind: 'error', message: summarizeToolResultInline(result.content) }
  }

  if (typeof row?.secondary === 'object' && row.secondary.kind === 'delta') return { kind: 'delta', metric: row.secondary }
  if (typeof row?.secondary === 'string' && shouldPreferRowSecondary(call.name, row.secondary)) return { kind: 'text', text: row.secondary }
  const text = summarizeToolResultInline(result.content)
  return text ? { kind: 'text', text, title: result.content } : { kind: 'none' }
}

function shouldPreferRowSecondary(toolName: string, secondary: string): boolean {
  if (secondary === 'ok' || secondary === 'failed') return false
  return toolName === 'read' || toolName === 'read_file' || toolName === 'read_files' || toolName === 'ls' || toolName === 'glob' || toolName === 'grep'
}

function shouldShowCompactHeaderText(toolName: string, text: string): boolean {
  if (!text || text === '(no output)') return false
  return shouldPreferRowSecondary(toolName, text)
}

function ToolHeaderResultSummaryView({
  summary,
  hideDelta = false,
}: {
  summary: ToolHeaderResultSummary
  hideDelta?: boolean
}): JSX.Element | null {
  if (summary.kind === 'none') return null
  if (summary.kind === 'delta' && hideDelta) return null
  if (summary.kind === 'delta') return <ToolDeltaBadges metric={summary.metric} />
  if (summary.kind === 'error') {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {summary.code ? <ToolTextBadge tone="danger">{summary.code}</ToolTextBadge> : null}
        <span className="min-w-0 truncate text-[11px] leading-5 text-rose-700 dark:text-rose-300" title={summary.message}>
          {summary.message}
        </span>
      </span>
    )
  }
  return (
    <span className="min-w-0 truncate text-[11px] leading-5 text-muted-foreground" title={summary.title ?? summary.text}>
      {summary.text}
    </span>
  )
}

function summarizeStructuredToolResult(text: string): string | null {
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const summary = typeof record.summary === 'string' ? record.summary : ''
    const files = Array.isArray(record.files) ? record.files : []
    const firstFile = files.find((file): file is Record<string, unknown> => !!file && typeof file === 'object' && !Array.isArray(file))
    const replacements = Array.isArray(firstFile?.replacements)
      ? firstFile.replacements.reduce((sum, item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return sum
          const count = (item as Record<string, unknown>).count
          return sum + (typeof count === 'number' && Number.isFinite(count) ? count : 0)
        }, 0)
      : null
    const pieces: string[] = []
    if (replacements !== null) pieces.push(`${replacements} replacement${replacements === 1 ? '' : 's'}`)
    if (pieces.length > 0) return pieces.join(' · ')
    if (summary) return truncate(summary, 72)
    return null
  } catch {
    return null
  }
}

const OVERFLOW_MARKER_PREFIX = '--- output truncated:'

function detectOverflowMarker(content: string): boolean {
  if (content.length < OVERFLOW_MARKER_PREFIX.length) return false
  const tail = content.slice(Math.max(0, content.length - 512))
  return tail.includes(OVERFLOW_MARKER_PREFIX)
}

function ToolCallGroupBlock({
  group,
  messageIndex,
  approvalByCallId,
  onApprovalDecision,
  liveToolActivityTailCount = DEFAULT_LIVE_TOOL_ACTIVITY_TAIL_COUNT,
  toolExecutionStartedAt,
  toolCardMode = 'dots',
  activeToolCallIds,
  badgeIntentionCallId,
}: {
  group: ToolCallGroup
  messageIndex: number
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>
  onApprovalDecision?: (callId: string, decision: 'approve' | 'reject') => void
  liveToolActivityTailCount?: number
  toolExecutionStartedAt?: number | null
  toolCardMode?: ToolCardMode
  activeToolCallIds: ReadonlySet<string> | null
  badgeIntentionCallId?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null)
  const [hoveredCallId, setHoveredCallId] = useState<string | null>(null)
  const [pinnedCallId, setPinnedCallId] = useState<string | null>(null)
  const rows = summarizeToolActivityRows(group)
  const anyPending = group.calls.some((c) => approvalByCallId.has(c.callId))
  const singleCall = group.calls.length === 1 ? group.calls[0]! : null
  const singleRow = singleCall ? rows.find((r) => r.callId === singleCall.callId) : null
  const singleResult = singleCall ? group.results.get(singleCall.callId) ?? null : null
  const singleHeaderResult = singleCall && singleResult
    ? summarizeToolResultForHeader(singleCall, singleRow ?? null, singleResult)
    : { kind: 'none' as const }
  const singlePending = singleCall ? approvalByCallId.get(singleCall.callId) ?? null : null
  const singleStatus = singlePending
    ? toolLifecycleBadge('approval')
    : singleResult
      ? singleResult.ok
        ? toolLifecycleBadge('succeeded')
        : toolLifecycleBadge('failed')
      : singleCall
        ? toolLifecycleBadge(isActiveToolCall(singleCall.callId, activeToolCallIds) ? 'running' : 'orphaned')
        : null
  const groupLifecycle = summarizeToolGroupLifecycle(group, approvalByCallId, activeToolCallIds)
  const toolMix = summarizeToolMix(group.calls)
  const fallbackIntent = [...group.calls].reverse().find((call) => call.intent?.trim())?.intent?.trim() ?? ''
  const primaryTargets = summarizePrimaryTargets(rows, group.mixed ? 2 : 1)
  const groupTitle = group.mixed ? 'Tool activity' : group.toolName
  const liveTailCount = Math.max(0, Math.round(liveToolActivityTailCount))
  const unresolvedTailCallIds = liveTailCount > 0
    ? group.calls
        .slice(-liveTailCount)
        .filter((call) => !group.results.has(call.callId) && !approvalByCallId.has(call.callId) && isActiveToolCall(call.callId, activeToolCallIds))
        .map((call) => call.callId)
    : []
  const autoRevealTail = group.mixed && unresolvedTailCallIds.length > 0
  const visibleTailCallIds = autoRevealTail ? new Set(unresolvedTailCallIds) : null
  const dots = toolActivityDots(group, rows, approvalByCallId, activeToolCallIds)
  const [iconScale] = useNumberPref(PREF_TOOL_ACTIVITY_ICON_SCALE, DEFAULT_TOOL_ACTIVITY_ICON_SCALE, { min: 100, max: 200 })
  const iconPixels = Math.round(14 * iconScale / 100)
  const nodePixels = iconPixels + 10
  const [dotBoundary, setDotBoundary] = useState<HTMLDivElement | null>(null)
  const [dotBoundaryWidth, setDotBoundaryWidth] = useState(0)
  useEffect(() => {
    if (!dotBoundary) return
    const update = (): void => setDotBoundaryWidth(dotBoundary.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(dotBoundary)
    return () => observer.disconnect()
  }, [dotBoundary])
  const railBudget = toolDotRailBudget(dotBoundaryWidth)
  const gapWidth = 8
  const omissionWidth = 40
  const limitWithoutOmission = railBudget > 0 ? Math.max(2, Math.floor((railBudget + gapWidth) / (nodePixels + gapWidth))) : 8
  const visibleDotLimit = dots.length > limitWithoutOmission
    ? Math.max(2, Math.floor((railBudget - omissionWidth + gapWidth) / (nodePixels + gapWidth)))
    : limitWithoutOmission
  const preferredDotIds = [pinnedCallId, ...dots.filter((dot) => dot.status === 'running').map((dot) => dot.callId)].filter((id): id is string => Boolean(id))
  const visibleDots = visibleToolDots(dots, visibleDotLimit, preferredDotIds)
  const omittedDotCount = Math.max(0, dots.length - visibleDots.length)
  const collapsedDots = toolCardMode === 'dots' && !open
  const showRows = open || anyPending || (!collapsedDots && autoRevealTail)

  // Live running state for this group: any dispatched call without a result and
  // not waiting on approval. When running, this card itself carries the dynamic
  // affordances that used to live in a second, redundant inline status card
  // (spinning wrench, elapsed timer, pulsing badge, breathing beam).
  const isRunning = dots.some((dot) => dot.status === 'running')
  const runningElapsed = useElapsedSeconds(isRunning, toolExecutionStartedAt)
  // A running call keeps its animated dot, but must not open the hover preview
  // until the user explicitly hovers, focuses, or pins that dot. Auto-opening
  // the fixed layer obscures transcript content while long-running tools execute.
  const previewCallId = pinnedCallId ?? hoveredCallId
  const previewCall = previewCallId
    ? group.calls.find((call) => call.callId === previewCallId) ?? null
    : null
  const previewRow = previewCallId
    ? rows.find((row) => row.callId === previewCallId) ?? null
    : null
  const previewStatus = previewCallId
    ? dots.find((dot) => dot.callId === previewCallId)?.status ?? null
    : null
  const previewResult = previewCallId ? group.results.get(previewCallId) ?? null : null
  const runningIntentCall = [...group.calls].reverse().find((call) => dots.find((dot) => dot.callId === call.callId)?.status === 'running' && call.intent?.trim())
  const inspectedIntent = previewCallId !== badgeIntentionCallId ? previewCall?.intent?.trim() : ''
  const groupOwnsBadgeIntention = group.calls.some((call) => call.callId === badgeIntentionCallId)
  const displayedIntent = inspectedIntent || (!runningIntentCall && !groupOwnsBadgeIntention ? fallbackIntent : '')
  const [previewPosition, setPreviewPosition] = useState<ToolPreviewGeometry | null>(null)
  useEffect(() => {
    if (!collapsedDots || !previewCallId || !previewRow || !previewStatus || typeof document === 'undefined') {
      setPreviewPosition(null)
      return
    }
    const anchor = document.getElementById(`tool-card-dot-anchor-${previewCallId}`)
    if (!anchor) {
      setPreviewPosition(null)
      return
    }
    const update = (): void => {
      const rect = anchor.getBoundingClientRect()
      setPreviewPosition(toolPreviewGeometry({
        anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [collapsedDots, previewCallId, previewStatus])

  const toggleOpen = (): void => {
    setHoveredCallId(null)
    setPinnedCallId(null)
    setOpen((v) => {
      const next = !v
      if (singleCall) setExpandedCallId(next ? singleCall.callId : null)
      return next
    })
  }

  return (
    <div
      id={`msg-${messageIndex}-group-${group.firstCallId}`}
      ref={setDotBoundary}
      className={cn(
        'w-full min-w-0 max-w-full transition-colors',
        collapsedDots
          ? 'overflow-visible'
          : 'overflow-hidden rounded-lg',
        !collapsedDots && (anyPending
          ? 'bg-amber-50/60 ring-1 ring-amber-400/60 dark:bg-amber-950/20 dark:ring-amber-500/40'
          : isRunning
            ? 'ak-tool-running bg-violet-50/50 ring-1 ring-violet-300/70 dark:bg-violet-950/20 dark:ring-violet-800/70'
            : 'bg-muted/40'),
      )}
      data-running={isRunning ? 'true' : undefined}
      data-testid={`tool-call-group-${group.firstCallId}`}
    >
      {collapsedDots ? (
        <div
          className="grid min-h-7 w-full min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0 overflow-visible max-sm:grid-cols-[minmax(0,1fr)_auto]"
          data-testid={`tool-card-dots-${group.firstCallId}`}
          aria-label={`${group.calls.length} tool calls`}
        >
          <div className="min-w-0 flex-none overflow-hidden" style={{ width: railBudget || undefined, maxWidth: '100%' }} data-testid="tool-activity-rail">
            <div className="relative flex w-max min-w-0 items-center gap-2 py-1">
              {visibleDots.length > 1 ? (
                <span className="pointer-events-none absolute top-1/2 z-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/60 shadow-[0_0_4px_hsl(var(--muted-foreground)/0.28)]" style={{ left: nodePixels / 2, right: nodePixels / 2 }} data-testid="tool-activity-connector" aria-hidden="true" />
              ) : null}
              {visibleDots.map((dot, index) => (
              <div key={dot.callId} className="relative z-10 flex flex-none items-center">
                <button
                  type="button"
                  id={`tool-card-dot-anchor-${dot.callId}`}
                  title={dot.title}
                  aria-label={dot.title}
                  aria-pressed={pinnedCallId === dot.callId}
                  data-testid={`tool-card-dot-${dot.callId}`}
                  onMouseEnter={() => setHoveredCallId(dot.callId)}
                  onMouseLeave={() => setHoveredCallId(null)}
                  onFocus={() => setHoveredCallId(dot.callId)}
                  onBlur={() => setHoveredCallId(null)}
                  onClick={() => {
                    setHoveredCallId(null)
                    setPinnedCallId((current) => current === dot.callId ? null : dot.callId)
                  }}
                  className="group/dot flex flex-none items-center justify-center rounded-full bg-background ring-offset-1 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ width: nodePixels, height: nodePixels }}
                >
                  <ToolActivityGlyph dot={dot} size={iconPixels} />
                </button>
                {omittedDotCount > 0 && index === Math.ceil(visibleDots.length / 2) - 1 ? (
                  <button type="button" onClick={toggleOpen} className="relative z-20 ml-2 flex h-6 min-w-9 flex-none items-center justify-center rounded-full bg-background px-1.5 font-mono text-[11px] font-bold tabular-nums text-foreground shadow-[0_0_0_4px_hsl(var(--background))] ring-1 ring-inset ring-foreground/30 hover:bg-muted" title={`${omittedDotCount} omitted tool calls`} aria-label={`${omittedDotCount} omitted tool calls; expand to inspect`} data-testid="tool-activity-omission">+{omittedDotCount}</button>
                ) : null}
              </div>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={toggleOpen}
            className="col-start-3 row-start-1 flex h-6 w-6 flex-none items-center justify-center rounded text-muted-foreground/65 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-sm:col-start-2 sm:h-5"
            aria-label="Expand tool activity"
            data-testid="tool-activity-direction"
          >
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {displayedIntent ? (
            <p
              className="col-start-2 row-start-1 min-w-0 whitespace-normal break-words text-[11px] leading-5 text-foreground/85 max-sm:col-span-2 max-sm:col-start-1 max-sm:row-start-2 max-sm:pr-1"
              data-testid={`tool-card-dots-intent-${group.firstCallId}`}
            >
              {displayedIntent}
            </p>
          ) : null}
          {previewCallId && previewCall && previewRow && previewStatus && previewPosition && typeof document !== 'undefined'
            ? createPortal(
                <div
                  className={cn(
                    'fixed z-[100] flex min-h-0 flex-col overflow-hidden border border-border/80 bg-popover p-2 text-popover-foreground shadow-2xl',
                    previewPosition.mobile ? 'rounded-t-2xl rounded-b-xl' : 'rounded-xl',
                    pinnedCallId === previewCallId ? 'pointer-events-auto' : 'pointer-events-none',
                  )}
                  style={{ left: previewPosition.left, top: previewPosition.top, width: previewPosition.width, maxHeight: previewPosition.maxHeight }}
                  data-placement={`${previewPosition.horizontal}-${previewPosition.vertical}`}
                  data-mobile={previewPosition.mobile ? 'true' : 'false'}
                  data-testid={`tool-card-preview-layer-${previewCallId}`}
                  role={pinnedCallId === previewCallId ? 'dialog' : 'tooltip'}
                  onWheel={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <div className="mb-2 flex min-w-0 items-center justify-between gap-3 px-1 py-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <ToolNameChip name={previewCall.name} />
                    </div>
                    <span className="flex flex-none items-center gap-1">
                      <ToolTextBadge tone={previewStatus === 'failed' ? 'danger' : previewStatus === 'succeeded' ? 'success' : previewStatus === 'approval' ? 'warning' : 'neutral'}>
                        {previewStatus}
                      </ToolTextBadge>
                      {pinnedCallId === previewCallId ? (
                        <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setPinnedCallId(null)} aria-label="Close tool details" data-testid="tool-card-preview-close">
                          <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <div className="grid min-h-0 min-w-0 flex-1 touch-pan-y gap-2 overflow-y-auto overscroll-contain pr-1" data-testid={`tool-card-preview-scroll-${previewCallId}`}>
                    <ToolCallInlineDetail
                      call={previewCall}
                      approval={approvalByCallId.get(previewCallId) ?? null}
                      compactNarrative
                    />
                    {previewResult ? <ToolResultInlineDetail result={previewResult} compactNarrative /> : <GroupSummaryPreview row={previewRow} status={previewStatus} />}
                  </div>
                </div>,
                document.body,
              )
            : null}
        </div>
      ) : (
      <button
        type="button"
        onClick={toggleOpen}
        className={cn(
          'grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-foreground transition-colors max-sm:grid-cols-[auto_minmax(0,1fr)]',
          anyPending
            ? 'hover:bg-amber-100/40 dark:hover:bg-amber-950/30'
            : 'hover:bg-muted',
        )}
        data-testid={
          singleCall
            ? `grouped-tool-row-${singleCall.callId}`
            : `tool-call-group-toggle-${group.firstCallId}`
        }
      >
        <Wrench
          className={cn(
            'h-3.5 w-3.5 flex-none',
            anyPending
              ? 'text-amber-600 dark:text-amber-400'
              : isRunning
                ? 'text-violet-600 animate-[spin_2s_linear_infinite] dark:text-violet-300'
                : 'text-muted-foreground',
          )}
        />
        <span className="flex min-w-0 items-center gap-1.5">
          <ToolNameChip name={groupTitle} />
          {toolCardMode !== 'dots' && singleCall?.intent ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={singleCall.intent} data-testid={`tool-call-intent-${singleCall.callId}`}>
              {singleCall.intent}
            </span>
          ) : toolCardMode !== 'dots' && fallbackIntent ? (
            <span className="min-w-0 whitespace-normal break-words text-[11px] text-muted-foreground" data-testid={`tool-call-intent-summary-${group.firstCallId}`}>
              {fallbackIntent}
            </span>
          ) : toolCardMode !== 'dots' && singleRow?.primary ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-foreground [overflow-wrap:anywhere]" title={singleRow.primary}>
              {singleRow.primary}
            </span>
          ) : group.mixed ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={toolMix}>
              {toolMix}
            </span>
          ) : toolCardMode !== 'dots' && primaryTargets ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-foreground [overflow-wrap:anywhere]" title={primaryTargets}>
              {primaryTargets}
            </span>
          ) : null}
          {singleHeaderResult.kind === 'error' ? (
            <span className="hidden min-w-0 items-center gap-1.5 sm:flex">
              <ToolHeaderResultSummaryView summary={singleHeaderResult} hideDelta />
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-none flex-wrap items-center justify-end gap-1.5 max-sm:col-span-2 max-sm:justify-start max-sm:pl-5">
          {singleHeaderResult.kind === 'delta' ? <ToolDeltaBadges metric={singleHeaderResult.metric} /> : null}
          {singleHeaderResult.kind === 'text' && shouldShowCompactHeaderText(singleCall?.name ?? '', singleHeaderResult.text) ? (
            <span className="hidden h-5 max-w-32 items-center truncate rounded bg-background/70 px-1.5 text-[11px] leading-none text-muted-foreground lg:inline-flex" title={singleHeaderResult.title ?? singleHeaderResult.text}>
              {singleHeaderResult.text}
            </span>
          ) : null}
          {group.calls.length > 1 ? (
            <span
              className={cn(
                'inline-flex h-5 flex-none items-center rounded px-1.5 font-mono text-[11px] leading-none',
                group.mixed
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background/80 text-muted-foreground',
              )}
            >
              {group.mixed ? `${group.calls.length} ops` : `× ${group.calls.length}`}
            </span>
          ) : null}
          {!singleCall ? <ToolLifecycleSummaryBadges summary={groupLifecycle} /> : null}
          {isRunning ? (
            <span className="flex-none whitespace-nowrap font-mono text-[10px] tabular-nums text-violet-700/80 dark:text-violet-300/80" data-testid="tool-running-elapsed">
              ↳ {runningElapsed.toFixed(1)}s
            </span>
          ) : null}
          {singleStatus ? (
            <span
              className={cn(
                'inline-flex h-5 flex-none items-center rounded px-1.5 text-[10px] font-medium uppercase leading-none tracking-wider',
                singleStatus.className,
                isRunning && 'motion-safe:animate-pulse',
              )}
            >
              {singleStatus.label}
            </span>
          ) : null}
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
          )}
        </span>
      </button>
      )}
      {showRows ? (
        <div
          className="ak-expand-in flex min-w-0 max-w-full flex-col gap-0.5 overflow-hidden border-t border-border/40 px-3 pb-2 pt-1"
          data-testid={`tool-call-group-details-${group.firstCallId}`}
        >
          {rows.map((row) => {
            const call = group.calls.find((c) => c.callId === row.callId)!
            const result = group.results.get(row.callId)
            const expanded = expandedCallId === row.callId
            const pending = approvalByCallId.get(row.callId) ?? null
            if (singleCall && row.callId === singleCall.callId) {
              if (!expanded && !pending) return null
              return (
                <div
                  key={row.callId}
                  id={`msg-${messageIndex}-call-${row.callId}`}
                  className="mt-1 flex min-w-0 max-w-full flex-col gap-2 overflow-hidden pl-1"
                >
                  <ToolCallInlineDetail
                    call={call}
                    approval={pending}
                    onApprovalDecision={onApprovalDecision}
                  />
                  {result ? (
                  <ToolResultInlineDetail
                    result={result}
                  />
                ) : null}
                </div>
              )
            }
            const tailVisible = visibleTailCallIds?.has(row.callId) ?? false
            if (!open && !pending && !tailVisible) return null
            const rowStatus = approvalByCallId.has(row.callId)
              ? 'approval' as const
              : group.results.has(row.callId)
                ? group.results.get(row.callId)!.ok ? 'succeeded' as const : 'failed' as const
                : 'running' as const
            return (
              <div
                key={row.callId}
                id={`msg-${messageIndex}-call-${row.callId}`}
                className="min-w-0 max-w-full overflow-hidden"
              >
                <GroupSummaryRow
                  row={row}
                  intent={call.intent}
                  status={rowStatus}
                  onClick={() =>
                    setExpandedCallId((cur) => (cur === row.callId ? null : row.callId))
                  }
                />
                {expanded || pending ? (
                  <div className="ak-expand-in mt-1 flex min-w-0 max-w-full flex-col gap-2 overflow-hidden pl-5">
                    <ToolCallInlineDetail
                      call={call}
                      approval={pending}
                      onApprovalDecision={onApprovalDecision}
                    />
                    {result ? (
                      <ToolResultInlineDetail result={result} />
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

type ToolActivityDot = {
  callId: string
  status: 'succeeded' | 'failed' | 'approval' | 'running' | 'orphaned'
  kind: 'read' | 'search' | 'write' | 'shell' | 'web' | 'todo' | 'memory' | 'agent' | 'other'
  title: string
}

function toolActivityDots(
  group: ToolCallGroup,
  rows: readonly SummaryRow[],
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>,
  activeToolCallIds: ReadonlySet<string> | null,
): ToolActivityDot[] {
  return group.calls.map((call) => {
    const result = group.results.get(call.callId)
    const row = rows.find((candidate) => candidate.callId === call.callId)
    const status: ToolActivityDot['status'] = approvalByCallId.has(call.callId)
      ? 'approval'
      : result
        ? result.ok ? 'succeeded' : 'failed'
        : isActiveToolCall(call.callId, activeToolCallIds) ? 'running' : 'orphaned'
    return {
      callId: call.callId,
      status,
      kind: toolActivityKind(call.name),
      title: call.intent?.trim() || `${call.name} · ${status}`,
    }
  })
}

const READ_TOOLS = new Set(['read', 'read_file', 'read_files', 'ls', 'glob'])
const FILE_MUTATION_TOOLS = new Set(['write', 'write_file', 'edit', 'replace_in_file', 'replace_many_in_file', 'apply_file_patch'])
const SHELL_TOOLS = new Set(['bash', 'bash_output', 'kill_shell'])

function toolActivityKind(toolName: string): ToolActivityDot['kind'] {
  if (toolName === 'grep' || toolName === 'multi_grep') return 'search'
  if (READ_TOOLS.has(toolName)) return 'read'
  if (FILE_MUTATION_TOOLS.has(toolName)) return 'write'
  if (SHELL_TOOLS.has(toolName)) return 'shell'
  if (toolName === 'websearch' || toolName === 'webfetch') return 'web'
  if (toolName === 'todowrite' || toolName === 'todo_graph') return 'todo'
  if (toolName === 'memory') return 'memory'
  if (toolName === 'agent') return 'agent'
  return 'other'
}

function ToolActivityGlyph({ dot, size }: { dot: ToolActivityDot; size: number }): JSX.Element {
  const Icon = dot.kind === 'read' ? Eye : dot.kind === 'search' ? FileSearch : dot.kind === 'write' ? PenLine : dot.kind === 'shell' ? Terminal : dot.kind === 'web' ? Globe : dot.kind === 'todo' ? ListChecks : dot.kind === 'memory' ? Brain : dot.kind === 'agent' ? Bot : Wrench
  return (
    <span data-shape={dot.kind} className={cn('relative flex items-center justify-center rounded-full transition-transform group-hover/dot:scale-110', dot.status === 'succeeded' && 'text-emerald-600 dark:text-emerald-400', dot.status === 'failed' && 'text-rose-600 dark:text-rose-400', dot.status === 'approval' && 'text-amber-500', dot.status === 'running' && 'text-violet-600 dark:text-violet-300', dot.status === 'orphaned' && 'text-muted-foreground/70')} style={{ width: size, height: size }}>
      {dot.status === 'running' ? <span className="absolute inset-[-3px] animate-ping rounded-full bg-violet-500/25" aria-hidden="true" /> : null}
      {dot.status === 'running' ? <span className="absolute inset-[-2px] animate-pulse rounded-full ring-2 ring-violet-500/70 shadow-[0_0_8px_hsl(263_70%_60%/0.65)]" aria-hidden="true" /> : null}
      <Icon className={cn('relative stroke-[2.2]', dot.status === 'running' && 'animate-pulse')} style={{ width: size, height: size }} aria-hidden="true" />
      {dot.status === 'failed' ? <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-rose-500 ring-1 ring-background" aria-hidden="true" /> : null}
      {dot.status === 'approval' ? <span className="absolute -right-1 -top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400 ring-1 ring-background" aria-hidden="true" /> : null}
    </span>
  )
}

function middleTruncatedToolActivityDots(dots: readonly ToolActivityDot[], limit: number): ToolActivityDot[] {
  if (dots.length <= limit) return [...dots]
  const headCount = Math.ceil(limit / 2)
  const tailCount = Math.floor(limit / 2)
  return [...dots.slice(0, headCount), ...dots.slice(-tailCount)]
}

function summarizeToolActivityRows(group: ToolCallGroup): SummaryRow[] {
  if (!group.mixed) {
    return pickRenderer(group.toolName)({ calls: group.calls, results: group.results })
  }

  const rowsByCallId = new Map<string, SummaryRow>()
  for (const call of group.calls) {
    const renderer = pickRenderer(call.name)
    const row = renderer({ calls: [call], results: group.results })[0]
    if (!row) continue
    rowsByCallId.set(call.callId, {
      ...row,
      primary: `${call.name} · ${row.primary}`,
    })
  }
  return group.calls.map((call) => rowsByCallId.get(call.callId)).filter((row): row is SummaryRow => !!row)
}

function summarizeToolMix(calls: readonly ToolCallContent[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  return [...counts.entries()].map(([name, count]) => `${name} ${count}`).join(', ')
}

function summarizeToolIntents(calls: readonly ToolCallContent[], limit: number): string {
  const intents: string[] = []
  for (const call of calls) {
    const intent = call.intent?.trim()
    if (!intent || intents.includes(intent)) continue
    intents.push(intent)
  }
  if (intents.length === 0) return ''
  const visible = intents.slice(0, limit)
  const remainder = intents.length - visible.length
  return `${visible.join(' · ')}${remainder > 0 ? ` · +${remainder} more` : ''}`
}

function summarizePrimaryTargets(rows: readonly SummaryRow[], limit: number): string {
  const targets: string[] = []
  for (const row of rows) {
    if (!row.primary || targets.includes(row.primary)) continue
    targets.push(row.primary)
    if (targets.length >= limit) break
  }
  return targets.join(', ')
}

type ToolLifecycleKind = 'approval' | 'running' | 'succeeded' | 'failed' | 'orphaned'

function toolLifecycleBadge(kind: ToolLifecycleKind): { label: string; className: string } {
  if (kind === 'approval') {
    return { label: 'Needs approval', className: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' }
  }
  if (kind === 'running') {
    return { label: 'Running', className: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300' }
  }
  if (kind === 'failed') {
    return { label: 'Failed', className: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' }
  }
  if (kind === 'orphaned') {
    return { label: 'Orphaned', className: 'bg-background/80 text-muted-foreground' }
  }
  return { label: 'Succeeded', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' }
}

function isActiveToolCall(callId: string, activeToolCallIds: ReadonlySet<string> | null): boolean {
  return activeToolCallIds === null || activeToolCallIds.has(callId)
}

function summarizeToolGroupLifecycle(
  group: ToolCallGroup,
  approvalByCallId: ReadonlyMap<string, ApprovalRequiredEvent>,
  activeToolCallIds: ReadonlySet<string> | null,
): Partial<Record<ToolLifecycleKind, number>> {
  const summary: Partial<Record<ToolLifecycleKind, number>> = {}
  for (const call of group.calls) {
    const result = group.results.get(call.callId)
    const kind: ToolLifecycleKind = approvalByCallId.has(call.callId)
      ? 'approval'
      : result
        ? result.ok
          ? 'succeeded'
          : 'failed'
        : isActiveToolCall(call.callId, activeToolCallIds) ? 'running' : 'orphaned'
    summary[kind] = (summary[kind] ?? 0) + 1
  }
  return summary
}

function ToolLifecycleSummaryBadges({ summary }: { summary: Partial<Record<ToolLifecycleKind, number>> }): JSX.Element {
  const kinds: readonly ToolLifecycleKind[] = ['approval', 'running', 'failed', 'succeeded', 'orphaned']
  return (
    <span className="flex min-w-0 flex-none items-center gap-1 leading-none">
      {kinds.map((kind) => {
        const count = summary[kind] ?? 0
        if (count === 0) return null
        const badge = toolLifecycleBadge(kind)
        return (
          <span key={kind} className={cn('inline-flex h-5 items-center rounded px-1.5 text-[10px] font-medium uppercase leading-none tracking-wider', badge.className)}>
            {count} {badge.label}
          </span>
        )
      })}
    </span>
  )
}
