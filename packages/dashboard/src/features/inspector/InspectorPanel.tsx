import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bot,
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Diff,
  Database,
  GitBranch,
  Hammer,
  HeartPulse,
  Info,
  ListFilter,
  Network,
  SearchCode,
  ServerCog,
} from 'lucide-react'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  CallLlmEffect,
  Effect,
  Message,
  MessageContent,
  ToolSchema,
} from '@agent-kernel/kernel'
import { redactLlmTrace, type ContextSnapshot, type LLMTrace, type ServerHistoryPayload, type ServerLogArtifactPayload } from '@agent-kernel/shared'
import { useTranslation } from 'react-i18next'

import type { DashboardSocket, TimelineEntry } from '../../session.js'
import { stateFlow, type StateFlowStep } from '../../state-flow.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.js'
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
import { JsonBlock } from '../../components/ui/json-block.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import { withViewTransition } from '../../lib/viewTransition.js'
import { PREF_SHOW_TOOL_CALL_TAB, useBooleanPref } from '../../lib/prefs.js'
import {
  buildReplaySnapshots,
  buildRunHealth,
  diffStates,
  firstDivergence,
  parseTraceQuery,
  summarizeStateDiff,
  traceEntryMatchesQuery,
  type ReplaySnapshot,
  type RunHealthItem,
  type StateDiff,
  type StateDiffSummaryGroup,
  type StateDiffSummaryItem,
} from './debugger-model.js'
import {
  buildLlmCalls,
  contextProportions,
  messageContextKind,
  providerBodyHasKey,
  type ContextProportion,
  type ContextProportionKind,
  type LlmCall,
} from '../chat/context-composition.js'

type Props = {
  state: AgentState | null
  config?: AgentConfig | null
  contextSnapshot?: ContextSnapshot | null
  timeline: readonly TimelineEntry[]
  visibleMessagesCount?: number
  socket?: DashboardSocket | null
  parentSessionId?: string | null
  parentCursor?: number | null
  onFork?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
  onCollapse?(): void
}

type RuntimeView = 'state' | 'tools' | 'memory'
type InspectorView = 'trace' | 'llm' | 'tools' | 'status'
type TraceMode = 'list' | 'flow' | 'compare'
type LlmDetailView = 'assembler' | 'api'
type TraceCategory = 'user' | 'llm' | 'tool' | 'approval' | 'system'
type DetailSelection =
  | { kind: 'event'; entry: TimelineEntry; priorCallLlm: PriorCallLlm | null; flow?: StateFlowStep }
  | { kind: 'llm'; call: LlmCall }
  | { kind: 'tool'; call: ToolCallLifecycle }
  | null

type PriorCallLlm = { seq: number; effect: CallLlmEffect }

type ToolCallLifecycle = {
  callId: string
  name: string
  input: Record<string, unknown>
  requestedSeq?: number
  approvedSeq?: number
  rejectedSeq?: number
  dispatchedSeq?: number
  resultSeq?: number
  result?: Extract<AgentEvent, { kind: 'tool_result' }>
}

type SubAgentRelationSummary = {
  parentSessionId: string | null
  parentCursor: number | null
  total: number
  completed: number
  failed: number
  running: number
}

type StatusTopologyNode = {
  id: string
  label: string
  value: string
  status: 'ok' | 'warn' | 'error' | 'unknown'
}

function subAgentRelationSummary(
  parentSessionId: string | null,
  parentCursor: number | null,
  toolCalls: readonly ToolCallLifecycle[],
): SubAgentRelationSummary {
  const agentCalls = toolCalls.filter((call) => call.name === 'agent')
  return {
    parentSessionId,
    parentCursor,
    total: agentCalls.length,
    completed: agentCalls.filter((call) => call.result?.ok === true).length,
    failed: agentCalls.filter((call) => call.result?.ok === false).length,
    running: agentCalls.filter((call) => !call.result).length,
  }
}

function statusTopology(socket: DashboardSocket | null, state: AgentState | null, llmCalls: readonly LlmCall[]): readonly StatusTopologyNode[] {
  const lastLlm = llmCalls.at(-1) ?? null
  return [
    { id: 'dashboard', label: 'Dashboard', value: 'browser UI', status: 'ok' },
    {
      id: 'host',
      label: 'Host',
      value: socket ? (socket.connected ? 'socket connected' : 'socket disconnected') : 'no socket',
      status: socket ? (socket.connected ? 'ok' : 'error') : 'unknown',
    },
    {
      id: 'executor',
      label: 'Executor',
      value: state?.cwd ? state.cwd : 'cwd not reported',
      status: state?.cwd ? 'ok' : 'unknown',
    },
    {
      id: 'llm',
      label: 'LLM',
      value: lastLlm ? `${llmCallProvider(lastLlm)} / ${llmCallModel(lastLlm)}` : 'not called yet',
      status: lastLlm ? (lastLlm.error ? 'error' : lastLlm.trace ? 'ok' : 'warn') : 'unknown',
    },
  ]
}

const traceListItemClass =
  'group relative min-w-0 overflow-hidden rounded-md border border-border/55 bg-card/45 px-2 py-1 text-xs shadow-[0_1px_0_rgba(0,0,0,0.03)] transition-colors dark:bg-card/35'

const TRACE_CATEGORY_ORDER = ['user', 'llm', 'tool', 'approval', 'system'] as const

const TRACE_CATEGORY_LABEL: Record<TraceCategory, string> = {
  user: 'User',
  llm: 'LLM',
  tool: 'Tool',
  approval: 'Approval',
  system: 'System',
}

const TRACE_CATEGORY_TONE: Record<TraceCategory, string> = {
  user: 'text-sky-600 dark:text-sky-300',
  llm: 'text-violet-600 dark:text-violet-300',
  tool: 'text-emerald-600 dark:text-emerald-300',
  approval: 'text-amber-600 dark:text-amber-300',
  system: 'text-muted-foreground',
}

export function InspectorPanel({
  state,
  config,
  contextSnapshot,
  timeline,
  visibleMessagesCount,
  socket,
  parentSessionId,
  parentCursor,
  onFork,
  onJumpToMessage,
  onCollapse,
}: Props): JSX.Element {
  const [inspectorView, setInspectorView] = useState<InspectorView>('trace')
  const [runtimeView, setRuntimeView] = useState<RuntimeView>('state')
  const [traceMode, setTraceMode] = useState<TraceMode>('list')
  const [traceQuery, setTraceQuery] = useState('')
  const [teachingMode, setTeachingMode] = useState(false)
  const [replaySeq, setReplaySeq] = useState<number | null>(null)
  const [selected, setSelected] = useState<DetailSelection>(null)
  const [pendingForkSeq, setPendingForkSeq] = useState<number | null>(null)
  const [traceFilter, setTraceFilter] = useState<ReadonlySet<TraceCategory>>(
    () => new Set<TraceCategory>(TRACE_CATEGORY_ORDER),
  )
  const [showToolCallTab] = useBooleanPref(PREF_SHOW_TOOL_CALL_TAB, true)

  useEffect(() => {
    // Auto-migrate away from the Tool Call tab if the user just disabled it.
    if (!showToolCallTab && inspectorView === 'tools') setInspectorView('trace')
  }, [showToolCallTab, inspectorView])

  const flow = useMemo(() => stateFlow(timeline), [timeline])
  const llmCalls = useMemo(() => buildLlmCalls(timeline), [timeline])
  const toolCalls = useMemo(() => buildToolCalls(timeline), [timeline])
  const parentHistory = useHistoryTimeline(socket ?? null, parentSessionId ?? null)
  const replaySnapshots = useMemo(() => buildReplaySnapshots(timeline, state, config), [timeline, state, config])
  const replaySnapshot = useMemo(() => {
    if (replaySnapshots.length === 0) return null
    if (replaySeq === null) return replaySnapshots.at(-1) ?? null
    return replaySnapshots.find((snapshot) => snapshot.seq === replaySeq) ?? replaySnapshots.at(-1) ?? null
  }, [replaySnapshots, replaySeq])
  const activeTraceSeq = replaySnapshot?.seq ?? null
  const replayState = replaySeq === null ? state : (replaySnapshot?.after ?? state)
  const selectTraceSeq = (seq: number | null): void => {
    setReplaySeq(seq)
  }
  const inspectTraceSeq = (seq: number): void => {
    const entryIndex = timeline.findIndex((entry) => entry.seq === seq)
    const entry = timeline[entryIndex]
    if (!entry) return
    setReplaySeq(seq)
    setSelected({
      kind: 'event',
      entry,
      priorCallLlm: findPriorCallLlm(timeline, entryIndex),
      flow: flow.find((step) => step.seq === entry.seq),
    })
  }

  useEffect(() => {
    if (!socket || !state?.sessionId || selected?.kind !== 'event') return
    const entry = selected.entry
    if (!entry.hasEffectsArtifact && !entry.hasLlmTraceArtifact) return
    const sessionId = state.sessionId
    const onArtifact = (p: ServerLogArtifactPayload): void => {
      if (p.sessionId !== sessionId || p.seq !== entry.seq || p.error) return
      setSelected((current) => {
        if (current?.kind !== 'event' || current.entry.seq !== entry.seq) return current
        return {
          ...current,
          entry: {
            ...current.entry,
            ...(p.effects ? { effects: p.effects } : {}),
            ...(p.llmTrace ? { llmTrace: p.llmTrace } : {}),
            hasEffectsArtifact: false,
            hasLlmTraceArtifact: false,
          },
        }
      })
    }
    socket.on('server:log_artifact', onArtifact)
    socket.emit('client:load_log_artifact', { sessionId, seq: entry.seq })
    return () => {
      socket.off('server:log_artifact', onArtifact)
    }
  }, [socket, selected, state?.sessionId])

  useEffect(() => {
    if (replaySnapshots.length === 0) {
      if (replaySeq !== null) setReplaySeq(null)
      return
    }
    if (replaySeq !== null && !replaySnapshots.some((snapshot) => snapshot.seq === replaySeq)) {
      setReplaySeq(replaySnapshots.at(-1)?.seq ?? null)
    }
  }, [replaySeq, replaySnapshots])

  const confirmFork = (): void => {
    if (pendingForkSeq !== null && onFork) onFork(pendingForkSeq)
    setPendingForkSeq(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-foreground">
      <DebuggerHeader
        state={state}
        config={config}
        timeline={timeline}
        visibleMessagesCount={visibleMessagesCount}
      />
      <InspectorTabs
        value={inspectorView}
        onChange={(next) => withViewTransition(() => setInspectorView(next))}
        showToolCallTab={showToolCallTab}
        onCollapse={onCollapse}
      />

      {inspectorView === 'status' ? (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="inspector-view-panel-status">
          <Overview state={state} config={config} timeline={timeline} visibleMessagesCount={visibleMessagesCount} />
          <div className="min-h-0 flex-1">
            <RuntimeSection
              view={runtimeView}
              onViewChange={setRuntimeView}
              state={state}
              replayState={replayState}
              replaySeq={replaySeq}
              config={config}
              contextSnapshot={contextSnapshot}
              timeline={timeline}
              toolCalls={toolCalls}
              subAgentRelation={subAgentRelationSummary(parentSessionId ?? null, parentCursor ?? null, toolCalls)}
              topology={statusTopology(socket ?? null, state, llmCalls)}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1" data-testid={`inspector-view-panel-${inspectorView}`}>
          <TraceSection
            view={inspectorView}
            timeline={timeline}
            flow={flow}
            llmCalls={llmCalls}
            toolCalls={toolCalls}
            messagesCount={visibleMessagesCount ?? state?.messages.length ?? 0}
            selected={selected}
            onSelect={setSelected}
            traceMode={traceMode}
            onTraceModeChange={setTraceMode}
            traceQuery={traceQuery}
            onTraceQueryChange={setTraceQuery}
            teachingMode={teachingMode}
            onTeachingModeChange={setTeachingMode}
            replaySnapshots={replaySnapshots}
            replaySnapshot={replaySnapshot}
            activeReplaySeq={activeTraceSeq}
            onReplaySeqChange={selectTraceSeq}
            onInspectReplaySeq={inspectTraceSeq}
            parentHistory={parentHistory}
            parentSessionId={parentSessionId ?? null}
            parentCursor={parentCursor ?? null}
            onForkRequest={onFork ? (seq) => setPendingForkSeq(seq) : undefined}
            onJumpToMessage={onJumpToMessage}
            traceFilter={traceFilter}
            onTraceFilterChange={setTraceFilter}
          />
        </div>
      )}

      <DetailDialog
        selection={selected}
        timeline={timeline}
        onForkRequest={onFork ? (seq) => setPendingForkSeq(seq) : undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      />

      <AlertDialog
        open={pendingForkSeq !== null}
        onOpenChange={(open) => {
          if (!open) setPendingForkSeq(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <ForkDialogTitle />
            <AlertDialogDescription>
              <ForkDialogDescription cursor={pendingForkSeq ?? ''} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <ForkDialogCancel />
            <AlertDialogAction onClick={confirmFork} data-testid="confirm-fork-button">
              <ForkDialogActionLabel />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function InspectorTabs({
  value,
  onChange,
  showToolCallTab,
  onCollapse,
}: {
  value: InspectorView
  onChange(view: InspectorView): void
  showToolCallTab: boolean
  onCollapse?: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const options: Array<[InspectorView, string, typeof Activity]> = [
    ['trace', t('inspector.tabs.trace'), GitBranch],
    ['llm', t('inspector.tabs.llmApi'), Bot],
  ]
  if (showToolCallTab) options.push(['tools', t('inspector.tabs.toolCall'), Hammer])
  options.push(['status', t('inspector.tabs.status'), Activity])
  const cols = options.length
  return (
    <div className="flex-none bg-card px-3 pb-3" data-testid="inspector-sidebar-tabs">
      <div className="flex items-center gap-1 rounded bg-sidebar p-0.5 text-xs">
        <div
          className="grid min-w-0 flex-1"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {options.map(([view, label, Icon]) => (
            <button
              key={view}
              type="button"
              onClick={() => onChange(view)}
              className={cn('inline-flex min-w-0 items-center justify-center gap-1 rounded px-1 py-1.5 font-medium transition-colors sm:px-1.5', value === view ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground')}
              data-testid={`inspector-sidebar-tab-${view}`}
              aria-pressed={value === view}
            >
              <Icon className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
              <span className="hidden min-w-0 truncate min-[360px]:inline">{label}</span>
            </button>
          ))}
        </div>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            className="inline-flex h-7 w-7 flex-none items-center justify-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            data-testid="inspector-collapse-button"
            title={t('inspector.collapsePanel')}
            aria-label={t('inspector.collapsePanel')}
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ForkDialogTitle(): JSX.Element {
  const { t } = useTranslation()
  return <AlertDialogTitle>{t('inspector.fork.title')}</AlertDialogTitle>
}

function ForkDialogDescription({ cursor }: { cursor: number | string }): JSX.Element {
  const { t } = useTranslation()
  return <>{t('inspector.fork.description', { cursor })}</>
}

function ForkDialogCancel(): JSX.Element {
  const { t } = useTranslation()
  return <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
}

function ForkDialogActionLabel(): JSX.Element {
  const { t } = useTranslation()
  return <>{t('inspector.fork.action')}</>
}

type HistoryTimelineState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; timeline: readonly TimelineEntry[] }
  | { status: 'unavailable' }

function useHistoryTimeline(socket: DashboardSocket | null, sessionId: string | null): HistoryTimelineState {
  const [state, setState] = useState<HistoryTimelineState>({ status: 'idle' })

  useEffect(() => {
    if (!socket || !sessionId) {
      setState({ status: 'idle' })
      return
    }
    setState({ status: 'loading' })
    const onHistory = (p: ServerHistoryPayload): void => {
      if (p.sessionId !== sessionId) return
      const timeline = p.entries.map((e) => ({
          seq: e.seq,
          ts: e.ts,
          event: e.event,
          effects: e.effects,
          ...(e.hasEffectsArtifact ? { hasEffectsArtifact: true } : {}),
          ...(e.hasLlmTraceArtifact ? { hasLlmTraceArtifact: true } : {}),
          ...(e.llmTrace ? { llmTrace: e.llmTrace } : {}),
          ...(e.model ? { model: e.model } : {}),
        }))
      setState(timeline.length > 0 ? { status: 'ready', timeline } : { status: 'unavailable' })
    }
    socket.on('server:history', onHistory)
    socket.emit('client:load_history', { sessionId })
    return () => {
      socket.off('server:history', onHistory)
    }
  }, [socket, sessionId])

  return state
}

function DebuggerHeader({
  state,
  config,
  timeline,
  visibleMessagesCount,
}: {
  state: AgentState | null
  config?: AgentConfig | null
  contextSnapshot?: ContextSnapshot | null
  timeline: readonly TimelineEntry[]
  visibleMessagesCount?: number
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex-none bg-card px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <ServerCog className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="font-semibold text-foreground">{t('inspector.title')}</span>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              #{state?.cursor ?? timeline.at(-1)?.seq ?? 0}
            </span>
          </div>
        </div>
      </div>
      <div className="sr-only">
        {t('inspector.visibleMessages', { count: visibleMessagesCount ?? state?.messages.length ?? 0 })}
        {t('inspector.toolsCount', { count: config?.tools.length ?? 0 })}
      </div>
    </div>
  )
}

function Overview({
  state,
  config,
  timeline,
  visibleMessagesCount: _visibleMessagesCount,
}: {
  state: AgentState | null
  config?: AgentConfig | null
  timeline: readonly TimelineEntry[]
  visibleMessagesCount?: number
}): JSX.Element {
  const { t } = useTranslation()
  const contextLimit = config?.contextLimit
  const context = contextLimit
    ? `${state?.usage.inputTokens ?? 0} / ${contextLimit}`
    : `${state?.usage.inputTokens ?? 0} input`
  const pending = state?.pendingCalls.find((c) => c.status !== 'rejected')
  return (
    <section className="flex-none bg-card px-3 pb-3" aria-label={t('inspector.overview')}>
      <div className="grid grid-cols-2 gap-1.5 text-xs xl:grid-cols-4">
        <Metric label={t('inspector.metrics.status')} value={shortStatus(state?.status)} tone={statusTone(state?.status)} />
        <Metric label={t('inspector.metrics.events')} value={String(timeline.length)} />
        <Metric label={t('inspector.metrics.context')} value={context} />
        <Metric label={t('inspector.metrics.pending')} value={pending?.name ?? t('inspector.metrics.none')} tone={pending ? 'text-amber-600 dark:text-amber-300' : undefined} />
      </div>
    </section>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }): JSX.Element {
  return (
    <div className="min-w-0 rounded bg-sidebar px-2 py-1.5 ring-1 ring-border/30">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 truncate font-mono text-[11px] text-foreground', tone)} title={value}>
        {value}
      </div>
    </div>
  )
}

function TraceSection({
  view,
  timeline,
  flow,
  llmCalls,
  toolCalls,
  messagesCount,
  selected,
  onSelect,
  traceMode,
  onTraceModeChange,
  traceQuery,
  onTraceQueryChange,
  teachingMode,
  onTeachingModeChange,
  replaySnapshots,
  replaySnapshot,
  activeReplaySeq,
  onReplaySeqChange,
  onInspectReplaySeq,
  parentHistory,
  parentSessionId,
  parentCursor,
  onForkRequest,
  onJumpToMessage,
  traceFilter,
  onTraceFilterChange,
}: {
  view: Exclude<InspectorView, 'status'>
  timeline: readonly TimelineEntry[]
  flow: readonly StateFlowStep[]
  llmCalls: readonly LlmCall[]
  toolCalls: readonly ToolCallLifecycle[]
  messagesCount: number
  selected: DetailSelection
  onSelect(selection: DetailSelection): void
  traceMode: TraceMode
  onTraceModeChange(mode: TraceMode): void
  traceQuery: string
  onTraceQueryChange(query: string): void
  teachingMode: boolean
  onTeachingModeChange(value: boolean): void
  replaySnapshots: readonly ReplaySnapshot[]
  replaySnapshot: ReplaySnapshot | null
  activeReplaySeq: number | null
  onReplaySeqChange(seq: number | null): void
  onInspectReplaySeq(seq: number): void
  parentHistory: HistoryTimelineState
  parentSessionId: string | null
  parentCursor: number | null
  onForkRequest?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
  traceFilter: ReadonlySet<TraceCategory>
  onTraceFilterChange(next: ReadonlySet<TraceCategory>): void
}): JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={view}>
      {view === 'trace' ? (
        <>
          <TraceToolbar
            filter={traceFilter}
            onFilterChange={onTraceFilterChange}
            mode={traceMode}
            onModeChange={onTraceModeChange}
            query={traceQuery}
            onQueryChange={onTraceQueryChange}
            teachingMode={teachingMode}
            onTeachingModeChange={onTeachingModeChange}
          />
          <ReplayPanel snapshots={replaySnapshots} selected={replaySnapshot} onSelect={onReplaySeqChange} />
          {traceMode === 'flow' ? (
            <ProtocolFlowView
              timeline={timeline}
              flow={flow}
              onInspectReplaySeq={onInspectReplaySeq}
              activeReplaySeq={activeReplaySeq}
              onReplaySeqChange={onReplaySeqChange}
              filter={traceFilter}
              query={traceQuery}
              teachingMode={teachingMode}
            />
          ) : traceMode === 'compare' ? (
            <ForkCompareView timeline={timeline} parentHistory={parentHistory} parentSessionId={parentSessionId} parentCursor={parentCursor} />
          ) : (
            <ReducerTrace
              timeline={timeline}
              flow={flow}
              messagesCount={messagesCount}
              onInspectReplaySeq={onInspectReplaySeq}
              onForkRequest={onForkRequest}
              onJumpToMessage={onJumpToMessage}
              filter={traceFilter}
              query={traceQuery}
              teachingMode={teachingMode}
              onReplaySeqChange={onReplaySeqChange}
              activeReplaySeq={activeReplaySeq}
            />
          )}
        </>
      ) : view === 'llm' ? (
        <LlmCallsView calls={llmCalls} selected={selected} onSelect={onSelect} />
      ) : (
        <ToolCallsView calls={toolCalls} selected={selected} onSelect={onSelect} />
      )}
    </section>
  )
}

function ReducerTrace({
  timeline,
  flow,
  messagesCount,
  onInspectReplaySeq,
  onForkRequest,
  onJumpToMessage,
  filter,
  query,
  teachingMode,
  onReplaySeqChange,
  activeReplaySeq,
}: {
  timeline: readonly TimelineEntry[]
  flow: readonly StateFlowStep[]
  messagesCount: number
  onInspectReplaySeq(seq: number): void
  onForkRequest?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
  filter: ReadonlySet<TraceCategory>
  query: string
  teachingMode: boolean
  onReplaySeqChange(seq: number | null): void
  activeReplaySeq: number | null
}): JSX.Element {
  const { t } = useTranslation()
  if (timeline.length === 0) {
    return <EmptyBlock label={t('inspector.empty.noReducerEvents')} />
  }
  const parsedQuery = parseTraceQuery(query)
  const visible = timeline.filter((entry) => {
    const inbound = inboundOf(entry.event)
    const prior = findPriorCallLlm(timeline, timeline.indexOf(entry))
    return entryMatchesFilter(entry, filter) && traceEntryMatchesQuery(entry, parsedQuery, inbound.source, eventSummary(entry.event, prior))
  })
  if (visible.length === 0) {
    return <EmptyBlock label={t('inspector.empty.noEventsMatch')} />
  }
  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_1rem] gap-1 bg-sidebar">
      <ScrollArea className="min-h-0 min-w-0">
      <div className="min-w-0 space-y-1 px-2 pb-3 pt-1" data-testid="reducer-trace-list">
        {visible.map((entry) => {
          const i = timeline.indexOf(entry)
          const priorCallLlm = findPriorCallLlm(timeline, i)
          const flowStep = flow.find((s) => s.seq === entry.seq)
          const isSelected = activeReplaySeq === entry.seq
          return (
            <ReducerTraceRow
              key={entry.seq}
              entry={entry}
              flow={flowStep}
              priorCallLlm={priorCallLlm}
              selected={isSelected}
              messageIndex={messageIndexFor(timeline, i, messagesCount)}
              onSelect={() => {
                onReplaySeqChange(entry.seq)
              }}
              onInspect={() => onInspectReplaySeq(entry.seq)}
              teachingMode={teachingMode}
              onForkRequest={onForkRequest}
              onJumpToMessage={onJumpToMessage}
            />
          )
        })}
      </div>
      </ScrollArea>
      <TimelineMinimap entries={visible} selectedSeq={activeReplaySeq} onSelect={onReplaySeqChange} />
    </div>
  )
}

function ReducerTraceRow({
  entry,
  flow,
  priorCallLlm,
  selected,
  messageIndex,
  onSelect,
  onInspect,
  teachingMode,
  onForkRequest,
  onJumpToMessage,
}: {
  entry: TimelineEntry
  flow?: StateFlowStep
  priorCallLlm: PriorCallLlm | null
  selected: boolean
  messageIndex: number | null
  onSelect(): void
  onInspect(): void
  teachingMode: boolean
  onForkRequest?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
}): JSX.Element {
  const { t } = useTranslation()
  const rowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!selected) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  const inbound = inboundOf(entry.event)
  const jumpable = messageIndex !== null && onJumpToMessage !== undefined
  const effectLabels = entry.effects.map((eff, i) => ({ key: `${eff.kind}-${i}`, effect: eff, target: effectTarget(eff) }))
  const summary = eventSummary(entry.event, priorCallLlm)
  return (
    <div
      ref={rowRef}
      className={cn(
        traceListItemClass,
        selected ? 'border-primary/50 bg-card ring-1 ring-primary/20' : 'hover:border-border hover:bg-card/80',
      )}
      data-testid="timeline-row"
      data-selected={selected ? 'true' : 'false'}
    >
      {selected ? <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-primary" /> : null}
      <button
        type="button"
        onClick={onSelect}
        className="grid w-full min-w-0 grid-cols-[2.35rem_minmax(0,1fr)] gap-x-1.5 overflow-hidden text-left"
        data-testid="timeline-row-header"
        aria-label={`select timeline event ${entry.seq}`}
      >
        <span className="pt-px text-right font-mono text-[10px] text-muted-foreground">#{entry.seq}</span>
        <span className="min-w-0 overflow-hidden">
          <span className="flex min-w-0 items-center gap-1">
            <span className={cn('w-12 flex-none font-mono text-[10px]', inbound.tone)}>{inbound.source}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{entry.event.kind}</span>
            {flow ? (
              <span className="hidden flex-none font-mono text-[10px] text-muted-foreground xl:inline">
                {flow.from} → {flow.to}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block min-w-0 truncate text-[10px] leading-4 text-muted-foreground" data-testid="timeline-row-summary" title={summary}>
            {summary}
          </span>
          {effectLabels.length > 0 ? (
            <span className="mt-0.5 flex min-w-0 max-w-full flex-wrap gap-0.5 overflow-hidden">
              {effectLabels.map(({ key, effect, target }) => (
                <span key={key} className="inline-block max-w-full truncate rounded bg-background/80 px-1 py-px font-mono text-[9px] leading-3 text-muted-foreground ring-1 ring-border/40" title={`${target.target} · ${effect.kind}`}>
                  <span className={target.tone}>{target.target}</span> · {effect.kind}
                </span>
              ))}
            </span>
          ) : null}
          {teachingMode ? (
            <span className="mt-1 block min-w-0 break-words rounded bg-muted/50 px-2 py-1 text-[10px] leading-4 text-muted-foreground ring-1 ring-border/30">
              {teachingText(entry, flow)}
            </span>
          ) : null}
        </span>
      </button>
      <div className="mt-0.5 flex min-w-0 flex-wrap justify-end gap-1 overflow-hidden pl-10 opacity-100 xl:opacity-0 xl:transition-opacity xl:group-hover:opacity-100 xl:group-focus-within:opacity-100">
        {jumpable ? (
          <MiniAction onClick={() => onJumpToMessage!(messageIndex!)} title={t('inspector.actions.jumpChatTitle', { index: messageIndex })}>
            {t('inspector.actions.jumpChat')}
          </MiniAction>
        ) : null}
        {onForkRequest ? (
          <MiniAction onClick={() => onForkRequest(entry.seq)} title={t('inspector.actions.forkTitle', { cursor: entry.seq })} ariaLabel={t('inspector.actions.forkAria', { cursor: entry.seq })}>
            <GitBranch className="h-3 w-3" aria-hidden="true" /> {t('inspector.actions.fork')}
          </MiniAction>
        ) : null}
        <MiniAction onClick={onInspect} title={t('inspector.actions.inspectRawJson')} testId="timeline-row-inspect-json">{t('inspector.actions.inspectJson')}</MiniAction>
      </div>
    </div>
  )
}

function LlmCallsView({
  calls,
  selected,
  onSelect,
}: {
  calls: readonly LlmCall[]
  selected: DetailSelection
  onSelect(selection: DetailSelection): void
}): JSX.Element {
  const { t } = useTranslation()
  if (calls.length === 0) return <EmptyBlock label={t('inspector.empty.noLlmCalls')} />
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-1 px-2 pb-3 pt-1" data-testid="llm-calls-list">
        {calls.map((call) => {
          const isSelected = selected?.kind === 'llm' && selected.call.id === call.id
          const usage = call.response?.usage
          const status = call.error ? 'error' : call.response ? String(call.trace?.response?.status ?? 'ok') : 'pending'
          const responseLabel = call.source === 'compact' && !call.error ? String(call.trace?.response?.status ?? 'compact') : status
          const provider = llmCallProvider(call)
          const model = llmCallModel(call)
          return (
            <button
              key={call.id}
              type="button"
              onClick={() => onSelect({ kind: 'llm', call })}
              className={cn(traceListItemClass, 'w-full max-w-full text-left', isSelected ? 'border-primary/50 bg-card ring-1 ring-primary/20' : 'hover:border-border hover:bg-card/80')}
              data-testid="llm-call-row"
            >
              {isSelected ? <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-primary" /> : null}
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="w-[4.75rem] flex-none font-mono text-[10px] text-muted-foreground">#{call.requestSeq} → {call.responseSeq ? `#${call.responseSeq}` : 'pending'}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-violet-600 dark:text-violet-300">{provider} / {model}</span>
                <span className={cn('flex-none font-mono text-[10px]', call.error ? 'text-rose-600 dark:text-rose-300' : 'text-muted-foreground')}>{responseLabel}</span>
              </div>
              <div className="mt-0.5 min-w-0 overflow-hidden truncate pl-[4.75rem] text-[10px] text-muted-foreground" title={llmResponseSummary(call)}>
                {t('inspector.llm.requestSummary', { messages: call.effect.messages.length, tools: call.effect.tools.length, response: llmResponseCardSummary(call) })}
              </div>
              <div className="mt-0.5 min-w-0 overflow-hidden truncate pl-[4.75rem] font-mono text-[10px] text-muted-foreground">
                {t('inspector.llm.usageSummary', { usage: usage ? `${usage.inputTokens}/${usage.outputTokens}` : t('inspector.llm.notReported'), trace: call.trace ? t('inspector.llm.captured') : t('inspector.llm.notCaptured') })}
              </div>
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function ToolCallsView({
  calls,
  selected,
  onSelect,
}: {
  calls: readonly ToolCallLifecycle[]
  selected: DetailSelection
  onSelect(selection: DetailSelection): void
}): JSX.Element {
  const { t } = useTranslation()
  if (calls.length === 0) return <EmptyBlock label={t('inspector.empty.noToolCalls')} />
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-1 px-2 pb-3 pt-1" data-testid="tool-calls-list">
        {calls.map((call) => {
          const isSelected = selected?.kind === 'tool' && selected.call.callId === call.callId
          return (
            <button
              key={call.callId}
              type="button"
              onClick={() => onSelect({ kind: 'tool', call })}
              className={cn(traceListItemClass, 'w-full max-w-full text-left', isSelected ? 'border-primary/50 bg-card ring-1 ring-primary/20' : 'hover:border-border hover:bg-card/80')}
              data-testid="tool-call-row"
            >
              {isSelected ? <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-primary" /> : null}
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">{call.callId}</span>
                <span className="flex-none font-mono text-[10px] text-emerald-600 dark:text-emerald-300">{call.name}</span>
                <span className={cn('flex-none font-mono text-[10px]', call.result?.ok === false ? 'text-rose-600 dark:text-rose-300' : 'text-muted-foreground')}>
                  {toolResultLabel(call)}
                </span>
              </div>
              <div className="mt-0.5 min-w-0 overflow-hidden truncate text-[10px] text-muted-foreground">
                {toolLifecycleSummary(call)}
              </div>
              <div className="mt-0.5 min-w-0 overflow-hidden truncate font-mono text-[10px] text-muted-foreground">
                {toolInputSummary(call.input)}
              </div>
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function ProtocolFlowView({
  timeline,
  flow,
  activeReplaySeq,
  onReplaySeqChange,
  onInspectReplaySeq,
  filter,
  query,
  teachingMode,
}: {
  timeline: readonly TimelineEntry[]
  flow: readonly StateFlowStep[]
  activeReplaySeq: number | null
  onReplaySeqChange(seq: number | null): void
  onInspectReplaySeq(seq: number): void
  filter: ReadonlySet<TraceCategory>
  query: string
  teachingMode: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const parsedQuery = parseTraceQuery(query)
  const visible = timeline.filter((entry) => {
    const inbound = inboundOf(entry.event)
    const prior = findPriorCallLlm(timeline, timeline.indexOf(entry))
    return entryMatchesFilter(entry, filter) && traceEntryMatchesQuery(entry, parsedQuery, inbound.source, eventSummary(entry.event, prior))
  })
  if (visible.length === 0) return <EmptyBlock label={t('inspector.trace.noRows')} />
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-1 px-2 pb-3 pt-1" data-testid="protocol-flow-view">
        <div className="grid grid-cols-[2.25rem_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.1fr)] gap-1.5 rounded bg-card/70 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground ring-1 ring-border/30">
          <span className="text-right">{t('inspector.trace.headers.seq')}</span>
          <span>{t('inspector.trace.headers.inputEvent')}</span>
          <span>{t('inspector.trace.headers.stateMachine')}</span>
          <span>{t('inspector.trace.headers.outputActions')}</span>
        </div>
        {visible.map((entry) => {
          const i = timeline.indexOf(entry)
          const inbound = inboundOf(entry.event)
          const step = flow.find((s) => s.seq === entry.seq)
          const priorCallLlm = findPriorCallLlm(timeline, i)
          const selectedRow = activeReplaySeq === entry.seq
          return (
            <div
              key={entry.seq}
              onClick={() => {
                onReplaySeqChange(entry.seq)
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onReplaySeqChange(entry.seq)
              }}
              className={cn(traceListItemClass, 'w-full text-left', selectedRow ? 'border-primary/50 bg-card ring-1 ring-primary/20' : 'hover:border-border hover:bg-card/80')}
              data-testid="protocol-flow-row"
            >
              <div className="grid grid-cols-[2.25rem_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.1fr)] items-center gap-1.5">
                <span className="text-right font-mono text-[10px] text-muted-foreground">#{entry.seq}</span>
                <FlowCell label={inbound.source} value={entry.event.kind} tone={inbound.tone} />
                <FlowCell label={t('inspector.trace.state')} value={step ? `${step.from} -> ${step.to}` : t('inspector.trace.stateStep')} tone="text-muted-foreground" />
                <div className="flex min-w-0 flex-wrap gap-1">
                  {entry.effects.length > 0 ? entry.effects.map((effect, index) => {
                    const target = effectTarget(effect)
                    return <span key={`${effect.kind}-${index}`} className="rounded bg-background/80 px-1 py-px font-mono text-[9px] ring-1 ring-border/35"><span className={target.tone}>{target.target}</span> · {effect.kind}</span>
                  }) : <span className="font-mono text-[10px] text-muted-foreground">{t('inspector.trace.noEffects')}</span>}
                </div>
              </div>
              {teachingMode ? <div className="mt-1 rounded bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground ring-1 ring-border/30">{teachingText(entry, step)}</div> : null}
              <div className="mt-1 flex justify-end">
                <MiniAction onClick={() => {
                  onInspectReplaySeq(entry.seq)
                }} title={t('inspector.actions.inspectRawJson')} testId="protocol-flow-inspect-json">{t('inspector.actions.inspectJson')}</MiniAction>
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function FlowCell({ label, value, tone }: { label: string; value: string; tone: string }): JSX.Element {
  return (
    <span className="min-w-0 rounded bg-background/70 px-1.5 py-1 ring-1 ring-border/25">
      <span className={cn('mr-1 font-mono text-[9px]', tone)}>{label}</span>
      <span className="font-mono text-[10px] text-foreground">{value}</span>
    </span>
  )
}

function ForkCompareView({
  timeline,
  parentHistory,
  parentSessionId,
  parentCursor,
}: {
  timeline: readonly TimelineEntry[]
  parentHistory: HistoryTimelineState
  parentSessionId: string | null
  parentCursor: number | null
}): JSX.Element {
  const { t } = useTranslation()
  if (!parentSessionId) return <EmptyBlock label={t('inspector.trace.noParentFork')} />
  if (parentHistory.status === 'idle' || parentHistory.status === 'loading') return <EmptyBlock label={t('inspector.trace.loadingParent')} />
  if (parentHistory.status === 'unavailable') return <EmptyBlock label={t('inspector.trace.parentUnavailable')} />
  const parentTimeline = parentHistory.timeline
  const divergence = firstDivergence(parentTimeline, timeline)
  const shared = divergence === -1 ? Math.min(parentTimeline.length, timeline.length) : divergence
  const parentTail = Math.max(0, parentTimeline.length - shared)
  const childTail = Math.max(0, timeline.length - shared)
  const firstParent = divergence >= 0 ? (parentTimeline[divergence] ?? null) : null
  const firstChild = divergence >= 0 ? (timeline[divergence] ?? null) : null
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-2 px-2 pb-3 pt-1" data-testid="fork-compare-view">
        <div className="rounded bg-background/70 p-2 text-xs ring-1 ring-border/30">
          <div className="flex min-w-0 items-center gap-2">
            <GitBranch className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{parentSessionId}{parentCursor !== null ? ` @${parentCursor}` : ''}</div>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <Metric label={t('inspector.trace.shared')} value={String(shared)} />
            <Metric label={t('inspector.trace.parentTail')} value={String(parentTail)} />
            <Metric label={t('inspector.trace.childTail')} value={String(childTail)} />
          </div>
        </div>
        <CompareColumn title={t('inspector.trace.firstParentRow')} entry={firstParent} />
        <CompareColumn title={t('inspector.trace.firstChildRow')} entry={firstChild} />
      </div>
    </ScrollArea>
  )
}

function CompareColumn({ title, entry }: { title: string; entry: TimelineEntry | null }): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="rounded bg-background/70 p-2 text-xs ring-1 ring-border/30">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      {entry ? (
        <>
          <div className="font-mono text-[11px] text-foreground">#{entry.seq} {entry.event.kind}</div>
          <div className="mt-1 truncate text-[10px] text-muted-foreground">{eventSummary(entry.event, null)}</div>
        </>
      ) : <div className="text-[11px] text-muted-foreground">{t('inspector.trace.noDivergence')}</div>}
    </div>
  )
}


function RuntimeSection({
  view,
  onViewChange,
  state,
  replayState,
  replaySeq,
  config,
  contextSnapshot,
  timeline,
  toolCalls,
  subAgentRelation,
  topology,
}: {
  view: RuntimeView
  onViewChange(view: RuntimeView): void
  state: AgentState | null
  replayState: AgentState | null
  replaySeq: number | null
  config?: AgentConfig | null
  contextSnapshot?: ContextSnapshot | null
  timeline: readonly TimelineEntry[]
  toolCalls: readonly ToolCallLifecycle[]
  subAgentRelation: SubAgentRelationSummary
  topology: readonly StatusTopologyNode[]
}): JSX.Element {
  const { t } = useTranslation()
  const health = useMemo(() => buildRunHealth(state, config, timeline, contextSnapshot), [state, config, timeline, contextSnapshot])
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('inspector.runtime.aria')}>
      <SectionHeader icon={Database} title={t('inspector.runtime.title')}>
        <Segmented<RuntimeView>
          value={view}
          onChange={onViewChange}
          options={[
            ['state', t('inspector.runtime.state'), CircleDot],
            ['tools', t('inspector.runtime.tools'), Hammer],
            ['memory', t('inspector.runtime.memory'), Brain],
          ]}
          testId="runtime-view-switch"
        />
      </SectionHeader>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)] gap-2 bg-card px-3 pb-3 pt-1">
        <StatusTopology nodes={topology} />
        <RunHealthPanel items={health} />
        {view === 'state' ? (
          <StateRuntime state={state} replayState={replayState} replaySeq={replaySeq} contextSnapshot={contextSnapshot} subAgentRelation={subAgentRelation} />
        ) : view === 'tools' ? (
          <ToolsRuntime tools={config?.tools ?? []} toolCalls={toolCalls} />
        ) : (
          <MemoryRuntime state={state} />
        )}
      </div>
    </section>
  )
}

function StatusTopology({ nodes }: { nodes: readonly StatusTopologyNode[] }): JSX.Element {
  return (
    <div className="grid gap-1.5 text-xs sm:grid-cols-2 xl:grid-cols-4" data-testid="status-topology">
      {nodes.map((node, index) => (
        <div key={node.id} className="flex min-w-0 items-center gap-2 rounded bg-background/70 px-2 py-1 ring-1 ring-border/30" title={node.value}>
          <span className={cn('h-2 w-2 flex-none rounded-full', topologyTone(node.status))} />
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{node.label}</span>
          <span className="min-w-0 truncate font-mono text-[10px] text-foreground">{node.value}</span>
          {index < nodes.length - 1 ? <ChevronRight className="hidden h-3 w-3 flex-none text-muted-foreground xl:block" aria-hidden="true" /> : null}
        </div>
      ))}
    </div>
  )
}

function topologyTone(status: StatusTopologyNode['status']): string {
  if (status === 'ok') return 'bg-emerald-500 dark:bg-emerald-400'
  if (status === 'warn') return 'bg-amber-500 dark:bg-amber-400'
  if (status === 'error') return 'bg-rose-500 dark:bg-rose-400'
  return 'bg-muted-foreground/50'
}

function StateRuntime({
  state,
  replayState,
  replaySeq,
  contextSnapshot,
  subAgentRelation,
}: {
  state: AgentState | null
  replayState: AgentState | null
  replaySeq: number | null
  contextSnapshot?: ContextSnapshot | null
  subAgentRelation: SubAgentRelationSummary
}): JSX.Element {
  const { t } = useTranslation()
  const [jsonOpen, setJsonOpen] = useState(false)
  const inspectedState = replayState ?? state
  if (!state) return <EmptyBlock label={t('inspector.runtime.noAgentState')} />
  const pendingCalls = inspectedState?.pendingCalls.map((c) => `${c.name} · ${c.status}`) ?? []
  // Session memory used to live on state.memory; it moved out of the kernel
  // in the protocol refactor and now flows via a host-side shadow-state
  // channel. Placeholder empty until that channel is wired in the dashboard.
  const memoryKeys: readonly string[] = []
  return (
    <>
      <ScrollArea className="h-full">
        <div className="space-y-2 pb-1" data-testid="state-runtime">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-foreground">AgentState</div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={state.sessionId}>{replaySeq !== null ? `replay #${replaySeq}` : state.sessionId}</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setJsonOpen(true)}>
              {t('inspector.runtime.viewJson')}
            </Button>
          </div>

          <SubAgentRelationPanel summary={subAgentRelation} />

          <div className="grid gap-2 xl:grid-cols-2">
            <StateGroup
              title={t('inspector.runtime.core')}
              rows={[
                ['status', inspectedState?.status ?? 'none'],
                ['cursor', String(inspectedState?.cursor ?? 0)],
                ['approval', inspectedState?.approvalMode ?? 'n/a'],
                ['cwd', inspectedState?.cwd ?? 'not set'],
              ]}
            />
            <StateGroup
              title={t('inspector.runtime.workload')}
              rows={[
                ['messages', String(inspectedState?.messages.length ?? 0)],
                ['pending', pendingCalls.length > 0 ? pendingCalls.join(', ') : 'none'],
                ['context pressure', contextSnapshot?.pressureLevel ?? 'n/a'],
                ['context input', contextSnapshot ? String(contextSnapshot.estimatedTotalInputTokens) : 'n/a'],
              ]}
            />
            <StateGroup
              title={t('inspector.runtime.usage')}
              rows={[
                ['input', String(inspectedState?.usage.inputTokens ?? 0)],
                ['output', String(inspectedState?.usage.outputTokens ?? 0)],
                ['cache create', String(inspectedState?.usage.cacheCreationTokens ?? 0)],
                ['cache read', String(inspectedState?.usage.cacheReadTokens ?? 0)],
              ]}
            />
            <StateGroup
              title={t('inspector.runtime.memory')}
              rows={[
                ['session entries', String(memoryKeys.length)],
                ['keys', memoryKeys.length > 0 ? memoryKeys.join(', ') : 'none'],
              ]}
            />
          </div>
        </div>
      </ScrollArea>
      <Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
        <DialogContent className="h-[86vh] max-w-5xl overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader className="bg-card px-4 py-3">
            <DialogTitle className="text-base">{t('inspector.runtime.agentStateJson')}</DialogTitle>
            <DialogDescription>{t('inspector.runtime.rawStateDescription')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 bg-background p-4" data-testid="agent-state-json-dialog">
            <ScrollArea className="h-full">
              <JsonBlock label={t('inspector.runtime.fullAgentStateJson')} value={inspectedState} collapsed={2} />
            </ScrollArea>
          </div>
          <DialogFooter className="bg-card px-4 py-3">
            <DialogClose asChild>
              <Button variant="outline" className="mt-0">{t('common.close')}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function StateGroup({ title, rows }: { title: string; rows: readonly (readonly [string, string])[] }): JSX.Element {
  return (
    <div className="min-w-0 overflow-hidden rounded bg-background/70 ring-1 ring-border/30">
      <div className="border-b border-border/40 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <KeyValueTable rows={rows} compact />
    </div>
  )
}

function SubAgentRelationPanel({ summary }: { summary: SubAgentRelationSummary }): JSX.Element | null {
  const { t } = useTranslation()
  if (!summary.parentSessionId && summary.total === 0) return null
  return (
    <div className="rounded bg-background/70 p-2 text-xs ring-1 ring-border/30" data-testid="sub-agent-relation-panel">
      <div className="mb-1.5 flex min-w-0 items-center gap-2">
        <Network className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
        <span className="font-medium text-foreground">{t('inspector.runtime.subAgentRelations')}</span>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={t('inspector.runtime.parent')} value={summary.parentSessionId ? `${summary.parentSessionId}${summary.parentCursor !== null ? ` @${summary.parentCursor}` : ''}` : 'none'} />
        <Metric label={t('inspector.runtime.children')} value={String(summary.total)} />
        <Metric label={t('inspector.runtime.completed')} value={String(summary.completed)} />
        <Metric label={t('inspector.runtime.running')} value={String(summary.running)} />
      </div>
      {summary.failed > 0 ? (
        <div className="mt-1.5 rounded bg-rose-500/10 px-2 py-1 text-[11px] text-rose-700 dark:text-rose-300">
          {t('inspector.runtime.subAgentFailed', { count: summary.failed })}
        </div>
      ) : null}
    </div>
  )
}

function RunHealthPanel({ items }: { items: readonly RunHealthItem[] }): JSX.Element {
  return (
    <div className="grid gap-1.5 text-xs sm:grid-cols-2 xl:grid-cols-3" data-testid="run-health-panel">
      {items.map((item) => (
        <div key={item.id} className="flex min-w-0 items-center gap-2 rounded bg-background/70 px-2 py-1 ring-1 ring-border/30">
          <HeartPulse className={cn('h-3 w-3 flex-none', healthTone(item.tone))} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{item.label}</span>
          <span className={cn('flex-none truncate font-mono text-[10px]', healthTone(item.tone))}>{item.value}</span>
        </div>
      ))}
    </div>
  )
}

function ToolsRuntime({ tools, toolCalls }: { tools: readonly ToolSchema[]; toolCalls: readonly ToolCallLifecycle[] }): JSX.Element {
  const { t } = useTranslation()
  const [selectedName, setSelectedName] = useState<string | null>(tools[0]?.name ?? null)
  const selectedTool = tools.find((t) => t.name === selectedName) ?? tools[0]
  if (tools.length === 0) return <EmptyBlock label={t('inspector.runtime.noTools')} />
  const recent = selectedTool ? toolCalls.filter((c) => c.name === selectedTool.name).slice(-5).reverse() : []
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(7rem,0.85fr)_minmax(0,1.15fr)] gap-2">
      <ScrollArea className="min-h-0 rounded bg-background/70 ring-1 ring-border/30" data-testid="tool-registry">
        <div className="p-1">
          {tools.map((tool) => (
            <button
              key={tool.name}
              type="button"
              onClick={() => setSelectedName(tool.name)}
              className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/70', selectedTool?.name === tool.name ? 'bg-muted' : '')}
              data-testid="tool-registry-item"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{tool.name}</span>
              {tool.toolsetId ? (
                <span className="hidden flex-none rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">{tool.toolsetId}</span>
              ) : null}
              {isSkillTool(tool) ? (
                <span className="flex-none rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">{t('inspector.runtime.skill')}</span>
              ) : null}
              <span className={cn('flex-none text-[10px]', tool.requiresApproval ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300')}>
                {tool.requiresApproval ? t('inspector.runtime.gated') : t('inspector.runtime.auto')}
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
      <ScrollArea className="min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="space-y-2 p-2 text-xs">
          {selectedTool ? (
            <>
              <div>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 truncate font-mono text-foreground">{selectedTool.name}</div>
                  {isSkillTool(selectedTool) ? (
                    <span className="flex-none rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">{t('inspector.runtime.skillLoader')}</span>
                  ) : null}
                </div>
                <div className="mt-1 text-muted-foreground">{selectedTool.requiresApproval ? t('inspector.runtime.approvalRequired') : t('inspector.runtime.autoAllowed')}</div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {[selectedTool.toolsetId ? `toolset ${selectedTool.toolsetId}` : null, selectedTool.risk ? `risk ${selectedTool.risk}` : null, selectedTool.executionKind ? `exec ${selectedTool.executionKind}` : null].filter(Boolean).join(' · ')}
                </div>
                <p className="mt-2 text-muted-foreground">{selectedTool.description || t('inspector.runtime.noDescription')}</p>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t('inspector.runtime.recentCalls')}</div>
                {recent.length > 0 ? (
                  <ul className="space-y-1">
                    {recent.map((call) => (
                      <li key={`${call.callId}-${call.resultSeq ?? 'pending'}`} className="truncate rounded bg-muted/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        #{call.requestedSeq ?? '?'} {toolResultLabel(call)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-[11px] text-muted-foreground">{t('inspector.runtime.noCalls')}</div>
                )}
              </div>
              <JsonBlock label={`Input schema · ${selectedTool.name}`} value={selectedTool.inputSchema} collapsed={2} className="[&>div:last-child]:max-h-56 [&_[data-radix-scroll-area-viewport]]:max-h-56" />
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}

function isSkillTool(tool: ToolSchema): boolean {
  return tool.name === 'skill'
}

function MemoryRuntime({ state: _state }: { state: AgentState | null }): JSX.Element {
  const { t } = useTranslation()
  // Session memory moved out of kernel state; the dashboard will consume a
  // host-shadow-state channel in a follow-up. Empty for now.
  const memory: ReadonlyArray<{ key: string; content: string; updatedAt: string }> = []
  const [scope, setScope] = useState<'session' | 'workspace' | 'global'>('session')
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(7rem,0.8fr)_minmax(0,1.2fr)] gap-2">
      <div className="rounded bg-background/70 p-1 text-xs ring-1 ring-border/30">
        {(['session', 'workspace', 'global'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted/70', scope === s ? 'bg-muted' : '')}
          >
            <span className="min-w-0 flex-1 truncate font-mono">{s}</span>
            <span className="flex-none text-[10px] text-muted-foreground">{s === 'session' ? `${memory.length}` : 'disk'}</span>
          </button>
        ))}
      </div>
      <ScrollArea className="min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="space-y-2 p-2 text-xs">
          {scope === 'session' ? (
            memory.length > 0 ? (
              memory.map((entry) => <MemoryEntryRow key={entry.key} entry={entry} />)
            ) : (
              <div className="text-muted-foreground">{t('inspector.runtime.noMemory')}</div>
            )
          ) : (
            <div className="space-y-2 text-muted-foreground">
              <div className="font-mono text-foreground">{scope}</div>
              <p>{t('inspector.runtime.workspaceMemoryNote', { scope })}</p>
              <p className="font-mono text-[11px]">{scope === 'workspace' ? '<workspace>/.agent-kernel/memory/' : '~/.agent-kernel/memory/'}</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function DetailDialog({
  selection,
  timeline,
  onForkRequest,
  onOpenChange,
}: {
  selection: DetailSelection
  timeline: readonly TimelineEntry[]
  onForkRequest?(cursor: number): void
  onOpenChange(open: boolean): void
}): JSX.Element {
  const { t } = useTranslation()
  const title = detailTitle(selection)
  const description = detailDescription(selection)
  return (
    <Dialog open={selection !== null} onOpenChange={onOpenChange}>
      <DialogContent className="h-[94vh] w-[96vw] max-w-[96vw] overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader className="bg-card px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <SearchCode className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-sm leading-6">{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 bg-background p-5">
          {selection ? (
            selection.kind === 'llm' ? (
              <LlmDetail call={selection.call} onForkRequest={onForkRequest} />
            ) : selection.kind === 'tool' ? (
              <ToolDetail call={selection.call} />
            ) : selection.entry.event.kind === 'messages_replaced' && selection.entry.event.reason === 'compaction' ? (
              <CompactDetail entry={selection.entry} />
            ) : (
              <EventDetail selection={selection} />
            )
          ) : null}
        </div>
        <DialogFooter className="bg-card px-4 py-3">
          <DialogClose asChild>
            <Button variant="outline" className="mt-0">{t('common.close')}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function detailTitle(selection: DetailSelection): string {
  if (!selection) return 'Selected Detail'
  if (selection.kind === 'llm') {
    if (selection.call.source === 'compact') return `Compaction LLM #${selection.call.requestSeq}`
    return `LLM Call #${selection.call.requestSeq} → ${selection.call.responseSeq ? `#${selection.call.responseSeq}` : 'pending'}`
  }
  if (selection.kind === 'tool') return `Tool Call · ${selection.call.name}`
  return `Timeline Event #${selection.entry.seq}`
}

function detailDescription(selection: DetailSelection): string {
  if (!selection) return 'Select a reducer event, LLM call, or tool call to inspect raw data.'
  if (selection.kind === 'llm') {
    return 'Kernel request, provider request/response trace, and parsed kernel response.'
  }
  if (selection.kind === 'tool') {
    return `${selection.call.callId} · ${toolLifecycleSummary(selection.call)}`
  }
  return `${selection.entry.event.kind} · reducer input, emitted effects, and raw JSON.`
}

function EventDetail({ selection }: { selection: Extract<DetailSelection, { kind: 'event' }> }): JSX.Element {
  const rows: readonly (readonly [string, string])[] = [
    ['reducer input', selection.entry.event.kind],
    ['previous status', selection.flow?.from ?? 'unknown'],
    ['next status', selection.flow?.to ?? 'unknown'],
    ['emitted effects', selection.entry.effects.map((e) => e.kind).join(', ') || 'none'],
  ]
  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 pb-1" data-testid="timeline-row-details">
        <KeyValueTable rows={rows} />
        <JsonBlock label={`Event JSON · ${selection.entry.event.kind}`} value={selection.entry.event} collapsed={2} />
        {selection.entry.effects.map((eff, i) => (
          <JsonBlock key={i} label={`Effect JSON · ${eff.kind}`} value={eff} collapsed={2} />
        ))}
      </div>
    </ScrollArea>
  )
}

function LlmDetail({ call, onForkRequest }: { call: LlmCall; onForkRequest?(cursor: number): void }): JSX.Element {
  const [view, setView] = useState<LlmDetailView>('assembler')
  const provider = llmCallProvider(call)
  const model = llmCallModel(call)
  const kernelEffect = call.effect
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="llm-detail">
      <PrimaryDetailTabs value={view} onChange={setView} />
      {view === 'assembler' ? (
        <MessageAssemblerView call={call} provider={provider} model={model} onForkRequest={onForkRequest} />
      ) : (
        <ApiCallView call={call} kernelEffect={kernelEffect} />
      )}
    </div>
  )
}

function PrimaryDetailTabs({ value, onChange }: { value: LlmDetailView; onChange(value: LlmDetailView): void }): JSX.Element {
  const options: readonly (readonly [LlmDetailView, string])[] = [
    ['assembler', 'Message Assembler'],
    ['api', 'API Call'],
  ]
  return (
    <div className="grid flex-none grid-cols-2 rounded bg-card p-0.5 ring-1 ring-border/50" data-testid="llm-detail-view-switch">
      {options.map(([tab, label]) => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          className={cn(
            'rounded px-3 py-1.5 text-xs font-medium transition-colors',
            value === tab
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
          )}
          data-testid={`llm-detail-view-switch-${tab}`}
          aria-pressed={value === tab}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function MessageAssemblerView({
  call,
  provider,
  model,
  onForkRequest,
}: {
  call: LlmCall
  provider: string
  model: string
  onForkRequest?(cursor: number): void
}): JSX.Element {
  const { t } = useTranslation()
  const [selectedContextKind, setSelectedContextKind] = useState<ContextProportionKind | null>(null)
  return (
    <div className="grid min-h-0 flex-1 gap-3 2xl:grid-cols-[minmax(22rem,0.92fr)_minmax(0,1.08fr)]" data-testid="message-assembler-view">
      <DetailPane title={t('inspector.llm.assemblyPipeline')} subtitle={t('inspector.llm.assemblySubtitle')}>
        <LlmAssemblyView
          call={call}
          provider={provider}
          model={model}
          selectedContextKind={selectedContextKind}
          onSelectContextKind={setSelectedContextKind}
        />
      </DetailPane>
      <DetailPane title={t('inspector.llm.kernelMessagesTools')} subtitle={t('inspector.llm.kernelMessagesToolsSubtitle')}>
        <LlmContextView
          messages={call.effect.messages}
          tools={call.effect.tools}
          selectedContextKind={selectedContextKind}
          forkCursor={call.requestSeq}
          onForkRequest={onForkRequest}
        />
      </DetailPane>
    </div>
  )
}

function DetailPane({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded bg-card ring-1 ring-border/70">
      <div className="flex-none border-b border-border/60 bg-muted/35 px-4 py-3">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-4">
        {children}
      </div>
    </section>
  )
}

function LlmAssemblyView({
  call,
  provider,
  model,
  selectedContextKind,
  onSelectContextKind,
}: {
  call: LlmCall
  provider: string
  model: string
  selectedContextKind: ContextProportionKind | null
  onSelectContextKind(kind: ContextProportionKind | null): void
}): JSX.Element {
  const { t } = useTranslation()
  const systemInfo = describeSystemInjection(call)
  const toolNames = call.effect.tools.map((tool) => `${tool.name}${tool.requiresApproval ? ' gated' : ' auto'}`)
  const proportions = contextProportions(call)
  return (
    <ScrollArea className="h-full min-h-0 flex-1">
      <div className="space-y-2" data-testid="llm-assembly-view">
        <CompactMetricGrid
          rows={[
            ['call', `#${call.requestSeq} → ${call.responseSeq ? `#${call.responseSeq}` : 'pending'}`],
            ['model', model === 'model unknown' ? 'not captured' : model],
            ['API adapter', call.trace ? apiAdapterLabel(provider) : 'not captured'],
            ['HTTP trace', call.trace ? 'captured' : 'not captured'],
            ['messages', String(call.effect.messages.length)],
            ['tools', String(call.effect.tools.length)],
          ]}
        />
        {!call.trace ? (
          <div className="rounded bg-amber-500/10 px-3 py-2 text-sm leading-6 text-amber-800 ring-1 ring-amber-500/20 dark:text-amber-200">
            {t('inspector.llm.missingTrace')}
          </div>
        ) : null}
        <ContextProportionBar items={proportions} selectedKind={selectedContextKind} onSelect={onSelectContextKind} />
        <AssemblyStep
          index="1"
          title={t('inspector.llm.systemPrompt')}
          result={systemInfo}
        />
        <AssemblyStep
          index="2"
          title={t('inspector.llm.kernelMessages')}
          result={`${call.effect.messages.length} messages: ${roleCounts(call.effect.messages)}`}
        />
        <AssemblyStep
          index="3"
          title={t('inspector.llm.toolRegistry')}
          result={toolNames.length > 0 ? toolNames.join(', ') : 'no tools sent'}
        />
        <AssemblyStep
          index="4"
          title={t('inspector.llm.adapterTransform')}
          result={adapterTransformSummary(provider)}
        />
      </div>
    </ScrollArea>
  )
}

function ContextProportionBar({
  items,
  selectedKind,
  onSelect,
}: {
  items: readonly ContextProportion[]
  selectedKind: ContextProportionKind | null
  onSelect(kind: ContextProportionKind | null): void
}): JSX.Element {
  const { t } = useTranslation()
  const nonZero = items.filter((item) => item.bytes > 0)
  return (
    <div className="rounded bg-background/70 p-3 text-sm ring-1 ring-border/30" data-testid="context-proportion-bar">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-foreground">{t('inspector.llm.contextComposition')}</div>
        <div className="font-mono text-xs text-muted-foreground">{t('inspector.llm.approxSerialized')}</div>
      </div>
      <div className="mt-2 flex h-3 overflow-hidden rounded bg-muted">
        {nonZero.length > 0 ? nonZero.map((item) => (
            <button
              key={item.kind}
              type="button"
              className={cn(item.color, 'h-full min-w-[3px] transition-opacity', selectedKind && selectedKind !== item.kind ? 'opacity-35' : 'opacity-100')}
              style={{ width: `${item.percent}%` }}
              title={`${item.label}: ${item.displayPercent}`}
              onClick={() => onSelect(selectedKind === item.kind ? null : item.kind)}
              data-testid={`context-proportion-segment-${item.kind}`}
              aria-pressed={selectedKind === item.kind}
            />
        )) : <div className="w-full bg-muted" />}
      </div>
      <div className="mt-2 grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <button
            key={item.kind}
            type="button"
            onClick={() => onSelect(selectedKind === item.kind ? null : item.kind)}
            className={cn(
              'flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors',
              selectedKind === item.kind ? 'bg-muted text-foreground ring-1 ring-border/40' : 'hover:bg-muted/60',
            )}
            data-testid={`context-proportion-legend-${item.kind}`}
            aria-pressed={selectedKind === item.kind}
          >
            <span className={cn('h-2 w-2 flex-none rounded', item.color)} />
            <span className="truncate text-muted-foreground">{item.label}</span>
            <span className="ml-auto flex-none font-mono text-foreground">{item.displayPercent}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function AssemblyStep({ index, title, result }: { index: string; title: string; result: string }): JSX.Element {
  return (
    <div className="rounded bg-background/70 p-3 text-sm ring-1 ring-border/30">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-primary/10 font-mono text-xs text-primary">{index}</span>
        <span className="font-medium text-foreground">{title}</span>
      </div>
      <div className="mt-2 min-w-0 break-words font-mono text-foreground">{result}</div>
    </div>
  )
}

function CompactMetricGrid({ rows }: { rows: readonly (readonly [string, string])[] }): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex min-w-0 items-center gap-2 rounded bg-background/70 px-3 py-2 text-sm ring-1 ring-border/30">
          <span className="flex-none text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-sm text-foreground" title={value}>{value}</span>
        </div>
      ))}
    </div>
  )
}

function LlmContextView({
  messages,
  tools,
  selectedContextKind,
  forkCursor,
  onForkRequest,
}: {
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  selectedContextKind: ContextProportionKind | null
  forkCursor?: number
  onForkRequest?(cursor: number): void
}): JSX.Element {
  const { t } = useTranslation()
  const [kind, setKind] = useState<'messages' | 'tools'>(selectedContextKind === 'tools' ? 'tools' : 'messages')
  useEffect(() => {
    if (selectedContextKind === 'tools') setKind('tools')
    else if (selectedContextKind) setKind('messages')
  }, [selectedContextKind])
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2" data-testid="llm-context-view">
      <div className="flex flex-none items-center gap-2">
        <div className="min-w-0 flex-1 text-sm leading-6 text-muted-foreground">
          {t('inspector.llm.contextDescription')}
        </div>
        <Segmented<'messages' | 'tools'>
          value={kind}
          onChange={setKind}
          options={[
            ['messages', t('inspector.llm.messagesTab')],
            ['tools', t('inspector.llm.toolsTab')],
          ]}
          testId="llm-context-view-switch"
        />
      </div>
      {kind === 'messages' ? (
        <KernelMessagesView messages={messages} selectedContextKind={selectedContextKind} forkCursor={forkCursor} onForkRequest={onForkRequest} />
      ) : (
        <ToolRegistryContextView tools={tools} selectedContextKind={selectedContextKind} />
      )}
    </div>
  )
}

function KernelMessagesView({
  messages,
  selectedContextKind,
  forkCursor,
  onForkRequest,
}: {
  messages: readonly Message[]
  selectedContextKind: ContextProportionKind | null
  forkCursor?: number
  onForkRequest?(cursor: number): void
}): JSX.Element {
  const { t } = useTranslation()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selected = messages[selectedIndex]
  return (
    <div className="grid h-full min-h-0 flex-1 grid-cols-[minmax(12rem,0.95fr)_minmax(0,1.05fr)] gap-2" data-testid="kernel-messages-view">
      <ScrollArea className="h-full min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="p-1">
          {messages.map((message, index) => {
            const highlighted = selectedContextKind !== null && messageContextKind(message) === selectedContextKind
            return (
            <div
              key={index}
              className={cn(
                'flex w-full min-w-0 items-start gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-muted/70',
                selectedIndex === index ? 'bg-muted' : '',
                highlighted ? 'ring-1 ring-primary/45 bg-primary/5' : '',
              )}
              data-testid="kernel-message-row"
              data-highlighted={highlighted ? 'true' : 'false'}
            >
              <button
                type="button"
                onClick={() => setSelectedIndex(index)}
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
              >
                <span className="w-8 flex-none font-mono text-xs text-muted-foreground">#{index}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn('w-20 flex-none font-mono text-xs', messageRoleTone(message.role))}>{message.role}</span>
                    <span className="truncate text-xs text-muted-foreground">{message.content.map((block) => block.type).join(', ') || t('inspector.llm.emptyBlocks')}</span>
                  </span>
                  <span className="mt-1 block truncate text-sm text-foreground">{summarizeContent(message.content)}</span>
                </span>
              </button>
              {onForkRequest && forkCursor !== undefined ? (
                <MiniAction
                  onClick={() => onForkRequest(forkCursor)}
                  title={t('inspector.actions.forkTitle', { cursor: forkCursor })}
                  ariaLabel={t('inspector.actions.forkAria', { cursor: forkCursor })}
                  testId={`kernel-message-fork-${index}`}
                >
                  <GitBranch className="h-3 w-3" aria-hidden="true" /> {t('inspector.actions.fork')}
                </MiniAction>
              ) : null}
            </div>
          )})}
        </div>
      </ScrollArea>
      <ScrollArea className="h-full min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="space-y-3 p-3 text-sm">
          {selected ? (
            <>
              <KeyValueTable
                rows={[
                  [t('inspector.llm.messageLabel'), `#${selectedIndex}`],
                  [t('inspector.llm.roleLabel'), selected.role],
                  [t('inspector.llm.blocksLabel'), selected.content.map((block) => block.type).join(', ') || t('inspector.llm.emptyBlocks')],
                ]}
              />
              <JsonBlock label={`Kernel Message #${selectedIndex}`} value={selected} collapsed={2} />
            </>
          ) : (
            <EmptyBlock label={t('inspector.empty.noKernelMessages')} />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function ToolRegistryContextView({
  tools,
  selectedContextKind,
}: {
  tools: readonly ToolSchema[]
  selectedContextKind: ContextProportionKind | null
}): JSX.Element {
  const { t } = useTranslation()
  const [selectedName, setSelectedName] = useState<string | null>(tools[0]?.name ?? null)
  const selected = tools.find((tool) => tool.name === selectedName) ?? tools[0]
  if (tools.length === 0) return <EmptyBlock label={t('inspector.empty.noLlmTools')} />
  return (
    <div className="grid h-full min-h-0 flex-1 grid-cols-[minmax(12rem,0.85fr)_minmax(0,1.15fr)] gap-2" data-testid="tool-registry-context-view">
      <ScrollArea className="h-full min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="p-1">
          {tools.map((tool) => {
            const highlighted = selectedContextKind === 'tools'
            return (
            <button
              key={tool.name}
              type="button"
              onClick={() => setSelectedName(tool.name)}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-muted/70',
                selected?.name === tool.name ? 'bg-muted' : '',
                highlighted ? 'ring-1 ring-primary/45 bg-primary/5' : '',
              )}
              data-testid="llm-tool-row"
              data-highlighted={highlighted ? 'true' : 'false'}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{tool.name}</span>
              {tool.toolsetId ? <span className="hidden flex-none rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">{tool.toolsetId}</span> : null}
              {isSkillTool(tool) ? <span className="flex-none rounded bg-sky-500/10 px-1.5 py-0.5 text-xs text-sky-700 dark:text-sky-300">{t('inspector.runtime.skill')}</span> : null}
              <span className={cn('flex-none text-xs', tool.requiresApproval ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300')}>
                {tool.requiresApproval ? t('inspector.runtime.gated') : t('inspector.runtime.auto')}
              </span>
            </button>
          )})}
        </div>
      </ScrollArea>
      <ScrollArea className="h-full min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="space-y-3 p-3 text-sm">
          {selected ? (
            <>
              <KeyValueTable
                rows={[
                  [t('inspector.llm.toolLabel'), selected.name],
                  [t('inspector.llm.approvalLabel'), selected.requiresApproval ? t('inspector.runtime.gated') : t('inspector.runtime.auto')],
                  ['toolset', selected.toolsetId ?? 'unknown'],
                  ['risk', selected.risk ?? 'unknown'],
                  ['execution', selected.executionKind ?? 'unknown'],
                  [t('inspector.llm.descriptionBytesLabel'), String(selected.description.length)],
                ]}
              />
              <p className="rounded bg-muted/50 px-2 py-1.5 text-muted-foreground">{selected.description || t('inspector.runtime.noDescription')}</p>
              <JsonBlock label={`Tool Schema · ${selected.name}`} value={selected} collapsed={2} />
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}

function ApiCallView({ call, kernelEffect }: { call: LlmCall; kernelEffect: CallLlmEffect }): JSX.Element {
  const { t } = useTranslation()
  const request = call.trace ? redactedApiRequest(call.trace) : null
  const body = call.trace?.request.body
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3" data-testid="api-call-view">
      <ApiSummaryStrip call={call} />
      <div className="grid min-h-0 gap-3 2xl:grid-cols-2">
      <DetailPane title={t('inspector.llm.apiRequest')} subtitle={t('inspector.llm.apiRequestSubtitle')}>
        <ScrollArea className="h-full min-h-0 flex-1" data-testid="api-request-view">
          <div className="space-y-2">
            {call.trace && request ? (
              <>
                <KeyValueTable
                  rows={[
                    ['url', request.url],
                    ['API adapter', apiAdapterLabel(providerFromTrace(call.trace))],
                    ['body.system', providerBodyHasKey(body, 'system') ? 'present' : 'not present'],
                    ['body.messages', providerArrayLength(body, 'messages')],
                    ['body.tools', providerArrayLength(body, 'tools')],
                  ]}
                />
                <AssemblyStep
                  index="A"
                  title={t('inspector.llm.apiBodySections')}
                  result={t('inspector.llm.apiBodyResult')}
                />
                <JsonBlock label={t('inspector.llm.capturedApiRequest')} value={request} collapsed={2} />
              </>
            ) : (
              <>
                <div className="rounded bg-amber-500/10 px-3 py-2 text-sm leading-6 text-amber-800 ring-1 ring-amber-500/20 dark:text-amber-200">
                  {t('inspector.llm.missingRequest')}
                </div>
                <JsonBlock label={`Kernel call_llm Effect @ #${call.requestSeq}`} value={kernelEffect} collapsed={1} />
              </>
            )}
          </div>
        </ScrollArea>
      </DetailPane>
      <DetailPane title={t('inspector.llm.apiResponse')} subtitle={t('inspector.llm.apiResponseSubtitle')}>
        <ScrollArea className="h-full min-h-0 flex-1" data-testid="api-response-view">
          <div className="space-y-2">
            {call.trace ? (
              <JsonBlock label={t('inspector.llm.capturedApiResponse')} value={call.trace.response ?? null} collapsed={2} />
            ) : (
              <div className="rounded bg-muted/40 px-3 py-2 text-sm leading-6 text-muted-foreground">
                {t('inspector.llm.oldTraceOnly')}
              </div>
            )}
          </div>
        </ScrollArea>
      </DetailPane>
      </div>
    </div>
  )
}

function ApiSummaryStrip({ call }: { call: LlmCall }): JSX.Element {
  const trace = call.trace
  const body = trace?.request.body
  const bodyKeys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body as Record<string, unknown>).join(', ') : 'not captured'
  const rows: readonly (readonly [string, string])[] = [
    ['provider', llmCallProvider(call)],
    ['model', llmCallModel(call)],
    ['request keys', bodyKeys || 'empty body'],
    ['response', trace?.response ? String(trace.response.status) : call.error ? 'kernel error' : 'not captured'],
    ['duration', formatTraceDuration(trace?.response?.metrics?.durationMs)],
    ['TTFT', formatTraceDuration(trace?.response?.metrics?.timeToFirstChunkMs)],
    ['stream events', String(trace?.response?.streamEventTypes?.length ?? 0)],
    ['HTTP trace', trace ? 'captured' : 'missing'],
  ]
  return (
    <div className="grid flex-none gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4" data-testid="api-summary-strip">
      {rows.map(([label, value]) => (
        <div key={label} className="flex min-w-0 items-center gap-2 rounded bg-card px-3 py-2 ring-1 ring-border/40">
          <span className="flex-none text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-sm text-foreground" title={value}>{value}</span>
        </div>
      ))}
    </div>
  )
}

function ToolDetail({ call }: { call: ToolCallLifecycle }): JSX.Element {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 pb-1" data-testid="tool-detail">
        <KeyValueTable
          rows={[
            ['callId', call.callId],
            ['tool', call.name],
            ['requested', call.requestedSeq ? `#${call.requestedSeq}` : 'unknown'],
            ['approved', call.approvedSeq ? `#${call.approvedSeq}` : call.rejectedSeq ? 'rejected' : 'auto/not required'],
            ['dispatched', call.dispatchedSeq ? `#${call.dispatchedSeq}` : 'not dispatched'],
            ['result', call.resultSeq ? `#${call.resultSeq} · ${toolResultLabel(call)}` : 'pending'],
          ]}
        />
        <JsonBlock label={`Tool Input · ${call.name}`} value={call.input} collapsed={2} />
        {call.result ? <JsonBlock label="Tool Result Event" value={call.result} collapsed={2} /> : null}
      </div>
    </ScrollArea>
  )
}

function CompactDetail({ entry }: { entry: TimelineEntry }): JSX.Element {
  if (entry.event.kind !== 'messages_replaced' || entry.event.reason !== 'compaction') return <EmptyBlock label="Not a compaction event." />
  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 pb-1" data-testid="timeline-row-details">
        <KeyValueTable
          rows={[
            ['reason', entry.event.reason],
            ['replace range', `${entry.event.replaceRange.start} → ${entry.event.replaceRange.end}`],
            ['replacement messages', String(entry.event.replacementMessages.length)],
          ]}
        />
        <JsonBlock label="Message Replacement" value={entry.event} collapsed={2} />
      </div>
    </ScrollArea>
  )
}

function SectionHeader({ icon: Icon, title, children }: { icon: typeof Activity; title: string; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-none items-center gap-2 bg-card px-3 py-2 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
      <span className="font-medium text-foreground">{title}</span>
      <div className="ml-auto min-w-0">{children}</div>
    </div>
  )
}

function Segmented<T extends string>({ value, onChange, options, testId }: { value: T; onChange(value: T): void; options: readonly (readonly [T, string, (typeof Activity)?])[]; testId: string }): JSX.Element {
  return (
    <div className="inline-flex rounded bg-sidebar p-0.5" data-testid={testId}>
      {options.map(([v, label, Icon]) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors', value === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground')}
            data-testid={`${testId}-${v}`}
          >
            {Icon ? <Icon className="h-3 w-3 flex-none" aria-hidden="true" /> : null}
            <span>{label}</span>
          </button>
      ))}
    </div>
  )
}

function MiniAction({ children, onClick, title, ariaLabel, testId }: { children: React.ReactNode; onClick(): void; title: string; ariaLabel?: string; testId?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
      className="inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-px text-[9px] uppercase tracking-wide text-muted-foreground ring-1 ring-border/30 hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}

function EmptyBlock({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex h-full min-h-[5rem] items-center justify-center rounded bg-card px-3 text-center text-xs text-muted-foreground ring-1 ring-border/30">
      {label}
    </div>
  )
}

function KeyValueTable({ rows, compact = false }: { rows: readonly (readonly [string, string])[]; compact?: boolean }): JSX.Element {
  return (
    <div className={cn('overflow-hidden', compact ? 'text-xs' : 'rounded bg-background/70 text-sm ring-1 ring-border/30')}>
      {rows.map(([k, v]) => (
        <div key={k} className={cn('grid gap-2 odd:bg-muted/50', compact ? 'grid-cols-[6.5rem_minmax(0,1fr)] px-2 py-1' : 'grid-cols-[9rem_minmax(0,1fr)] px-3 py-2')}>
          <div className="truncate text-muted-foreground">{k}</div>
          <div className="min-w-0 truncate font-mono text-foreground" title={v}>{v}</div>
        </div>
      ))}
    </div>
  )
}

function buildToolCalls(timeline: readonly TimelineEntry[]): readonly ToolCallLifecycle[] {
  const byId = new Map<string, ToolCallLifecycle>()
  const ensure = (callId: string, name: string, input: Record<string, unknown>): ToolCallLifecycle => {
    const existing = byId.get(callId)
    if (existing) return existing
    const next: ToolCallLifecycle = { callId, name, input }
    byId.set(callId, next)
    return next
  }
  for (const entry of timeline) {
    for (const effect of entry.effects) {
      if (effect.kind === 'request_approval') {
        const call = ensure(effect.callId, effect.name, effect.input)
        call.requestedSeq = entry.seq
      } else if (effect.kind === 'call_tool') {
        const call = ensure(effect.callId, effect.name, effect.input)
        call.dispatchedSeq = entry.seq
      }
    }
    if (entry.event.kind === 'llm_response') {
      for (const content of entry.event.message.content) {
        if (content.type === 'tool_call') {
          const call = ensure(content.callId, content.name, content.input)
          call.requestedSeq ??= entry.seq
        }
      }
    } else if (entry.event.kind === 'user_approve') {
      const call = byId.get(entry.event.callId)
      if (call) call.approvedSeq = entry.seq
    } else if (entry.event.kind === 'user_reject') {
      const call = byId.get(entry.event.callId)
      if (call) call.rejectedSeq = entry.seq
    } else if (entry.event.kind === 'tool_result') {
      const call = byId.get(entry.event.callId) ?? ensure(entry.event.callId, 'unknown', {})
      call.resultSeq = entry.seq
      call.result = entry.event
    }
  }
  return [...byId.values()].sort((a, b) => (a.requestedSeq ?? a.dispatchedSeq ?? 0) - (b.requestedSeq ?? b.dispatchedSeq ?? 0))
}

function findPriorCallLlm(timeline: readonly TimelineEntry[], i: number): PriorCallLlm | null {
  if (timeline[i]?.event.kind !== 'llm_response') return null
  for (let j = i - 1; j >= 0; j--) {
    const entry = timeline[j]!
    const eff = entry.effects.find((e): e is CallLlmEffect => e.kind === 'call_llm')
    if (eff) return { seq: entry.seq, effect: eff }
  }
  return null
}

function messageIndexFor(timeline: readonly TimelineEntry[], currentIndex: number, messagesCount: number): number | null {
  const t = timeline[currentIndex]
  if (!t) return null
  const producesMessage = t.event.kind === 'user_message' || t.event.kind === 'llm_response' || t.event.kind === 'tool_result'
  if (!producesMessage) return null
  let seen = -1
  for (let i = 0; i <= currentIndex; i++) {
    const ev = timeline[i]!.event
    if (ev.kind === 'user_message' || ev.kind === 'llm_response' || ev.kind === 'tool_result') seen += 1
  }
  if (seen < 0 || seen >= messagesCount) return null
  return seen
}

function inboundOf(event: AgentEvent): { source: string; tone: string } {
  switch (event.kind) {
    case 'user_message':
    case 'user_approve':
    case 'approval_mode_changed':
    case 'cwd_changed':
      return { source: 'user', tone: 'text-sky-600 dark:text-sky-300' }
    case 'llm_response':
      return { source: 'llm', tone: 'text-violet-600 dark:text-violet-300' }
    case 'llm_error':
      return { source: 'llm', tone: 'text-rose-600 dark:text-rose-300' }
    case 'user_reject':
      return { source: 'user', tone: 'text-rose-600 dark:text-rose-300' }
    case 'tool_result':
      return { source: 'executor', tone: event.ok ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300' }
    case 'cancel':
    case 'clear':
      return { source: 'user', tone: 'text-amber-600 dark:text-amber-300' }
    case 'messages_replaced':
      return { source: 'host', tone: 'text-amber-600 dark:text-amber-300' }
  }
}

function effectTarget(e: Effect): { target: string; tone: string } {
  switch (e.kind) {
    case 'call_llm':
      return { target: 'llm', tone: 'text-violet-600 dark:text-violet-300' }
    case 'call_tool':
      return { target: 'executor', tone: 'text-emerald-600 dark:text-emerald-300' }
    case 'request_approval':
      return { target: 'user', tone: 'text-amber-600 dark:text-amber-300' }
    case 'finish':
      return { target: 'done', tone: 'text-muted-foreground' }
    case 'emit_error':
      return { target: 'error', tone: 'text-rose-600 dark:text-rose-300' }
  }
}

function eventCategories(entry: TimelineEntry): Set<TraceCategory> {
  const categories = new Set<TraceCategory>()
  switch (entry.event.kind) {
    case 'user_message':
      categories.add('user')
      break
    case 'user_approve':
    case 'user_reject':
      categories.add('user')
      categories.add('approval')
      break
    case 'approval_mode_changed':
      categories.add('user')
      categories.add('approval')
      break
    case 'cwd_changed':
    case 'cancel':
    case 'clear':
      categories.add('user')
      break
    case 'llm_response':
    case 'llm_error':
      categories.add('llm')
      break
    case 'tool_result':
      categories.add('tool')
      break
    case 'messages_replaced':
      categories.add('system')
      break
  }
  for (const eff of entry.effects) {
    if (eff.kind === 'call_llm') categories.add('llm')
    else if (eff.kind === 'call_tool') categories.add('tool')
    else if (eff.kind === 'request_approval') categories.add('approval')
    else if (eff.kind === 'finish' || eff.kind === 'emit_error') categories.add('system')
  }
  return categories
}

function entryMatchesFilter(
  entry: TimelineEntry,
  filter: ReadonlySet<TraceCategory>,
): boolean {
  if (filter.size === 0) return true
  for (const cat of eventCategories(entry)) {
    if (filter.has(cat)) return true
  }
  return false
}

function TraceToolbar({
  filter,
  onFilterChange,
  mode,
  onModeChange,
  query,
  onQueryChange,
  teachingMode,
  onTeachingModeChange,
}: {
  filter: ReadonlySet<TraceCategory>
  onFilterChange(next: ReadonlySet<TraceCategory>): void
  mode: TraceMode
  onModeChange(mode: TraceMode): void
  query: string
  onQueryChange(query: string): void
  teachingMode: boolean
  onTeachingModeChange(value: boolean): void
}): JSX.Element {
  const { t } = useTranslation()
  const allSelected = filter.size === TRACE_CATEGORY_ORDER.length
  const toggle = (cat: TraceCategory): void => {
    const next = new Set(filter)
    if (next.has(cat)) next.delete(cat)
    else next.add(cat)
    onFilterChange(next)
  }
  const setAll = (): void => {
    onFilterChange(new Set<TraceCategory>(TRACE_CATEGORY_ORDER))
  }
  return (
    <div
      className="flex flex-none flex-col gap-1.5 bg-card/50 px-2 py-1.5"
      data-testid="trace-toolbar"
    >
      <div className="flex min-w-0 items-center gap-1">
        <Segmented<TraceMode>
          value={mode}
          onChange={onModeChange}
          options={[
            ['list', t('inspector.trace.list'), ListFilter],
            ['flow', t('inspector.trace.flow'), Network],
            ['compare', t('inspector.trace.compare'), Diff],
          ]}
          testId="trace-mode-switch"
        />
        <label className="ml-auto flex min-w-0 flex-1 items-center gap-1 rounded bg-background/70 px-2 py-1 text-[11px] ring-1 ring-border/30 focus-within:ring-border/60">
          <SearchCode className="h-3 w-3 flex-none text-muted-foreground" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="kind:llm_response effect:call_tool"
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="trace-query-input"
          />
        </label>
        <button
          type="button"
          onClick={() => onTeachingModeChange(!teachingMode)}
          aria-pressed={teachingMode}
          className={cn('inline-flex h-6 w-6 flex-none items-center justify-center rounded ring-1 transition-colors', teachingMode ? 'bg-primary/10 text-primary ring-primary/40' : 'bg-background/70 text-muted-foreground ring-border/30 hover:bg-accent hover:text-foreground')}
          title={t('inspector.trace.teachingMode')}
          data-testid="teaching-mode-toggle"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={setAll}
          aria-pressed={allSelected}
          data-testid="trace-filter-chip-all"
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 transition-colors',
            allSelected
              ? 'bg-primary/10 text-foreground ring-primary/40'
              : 'bg-background/70 text-muted-foreground ring-border/40 hover:bg-accent hover:text-foreground',
          )}
        >
          {t('inspector.trace.all')}
        </button>
        {TRACE_CATEGORY_ORDER.map((cat) => {
          const active = filter.has(cat)
          return (
          <button
            key={cat}
            type="button"
            onClick={() => toggle(cat)}
            aria-pressed={active}
            data-testid={`trace-filter-chip-${cat}`}
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 transition-colors',
              active
                ? 'bg-primary/10 ring-primary/40'
                : 'bg-background/70 ring-border/40 hover:bg-accent',
              active ? TRACE_CATEGORY_TONE[cat] : 'text-muted-foreground',
            )}
          >
            {TRACE_CATEGORY_LABEL[cat]}
          </button>
          )
        })}
      </div>
    </div>
  )
}

function ReplayPanel({
  snapshots,
  selected,
  onSelect,
}: {
  snapshots: readonly ReplaySnapshot[]
  selected: ReplaySnapshot | null
  onSelect(seq: number | null): void
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const [rawOpen, setRawOpen] = useState(false)
  if (snapshots.length === 0 || !selected) return <div className="flex-none bg-card/50 px-2 pb-1" />
  const diff = diffStates(selected.before, selected.after, 16)
  const summary = summarizeStateDiff(selected.before, selected.after, diff)
  const currentIndex = snapshots.findIndex((snapshot) => snapshot.seq === selected.seq)
  const previous = snapshots[currentIndex - 1]
  const next = snapshots[currentIndex + 1]
  return (
    <div className="flex-none bg-card/50 px-2 pb-2" data-testid="replay-panel">
      <div className="overflow-hidden rounded-md bg-background/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ring-1 ring-border/35">
        <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
            aria-expanded={open}
            aria-controls="state-diff-body"
            data-testid="state-diff-toggle"
          >
            <Diff className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{t('inspector.trace.stateDiff')}</div>
            <ChevronDown className={cn('h-3.5 w-3.5 flex-none text-muted-foreground transition-transform', open ? '' : '-rotate-90')} aria-hidden="true" />
          </button>
          <span className="rounded bg-muted/55 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground ring-1 ring-border/25">#{selected.seq}</span>
          <button type="button" disabled={!previous} onClick={() => previous && onSelect(previous.seq)} className="inline-flex h-5 w-5 items-center justify-center rounded bg-muted/55 text-muted-foreground ring-1 ring-border/25 hover:bg-accent hover:text-foreground disabled:opacity-40" title={t('inspector.trace.previousEvent')}>
            <ChevronLeft className="h-3 w-3" aria-hidden="true" />
          </button>
          <button type="button" disabled={!next} onClick={() => next && onSelect(next.seq)} className="inline-flex h-5 w-5 items-center justify-center rounded bg-muted/55 text-muted-foreground ring-1 ring-border/25 hover:bg-accent hover:text-foreground disabled:opacity-40" title={t('inspector.trace.nextEvent')}>
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => onSelect(null)} className="rounded bg-muted/55 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground ring-1 ring-border/25 hover:bg-accent hover:text-foreground">{t('inspector.trace.live')}</button>
        </div>
        <div className="px-2 pb-1.5">
          <input
            type="range"
            min={0}
            max={Math.max(0, snapshots.length - 1)}
            value={currentIndex}
            onChange={(event) => onSelect(snapshots[Number(event.currentTarget.value)]?.seq ?? null)}
            className="h-2 w-full accent-primary"
            aria-label={t('inspector.trace.replayCursor')}
            data-testid="replay-scrubber"
          />
        </div>
        {open ? <div id="state-diff-body" className="border-t border-border/30 bg-card/35 px-2 py-1.5">
          <div className="mb-1 flex min-w-0 items-center gap-2 text-[10px]">
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={selected.event.kind}>{selected.event.kind}</span>
            <span className="flex-none text-muted-foreground">{t('inspector.trace.changes', { count: diff.length })}</span>
          </div>
          <div className="min-w-0 space-y-1.5" data-testid="state-diff-view">
            {summary.length > 0 ? summary.map((group) => <DiffSummaryGroup key={group.id} group={group} />) : <div className="rounded bg-background/55 px-2 py-1 text-[10px] text-muted-foreground ring-1 ring-border/20">{t('inspector.trace.noStateChanges')}</div>}
            {diff.length > 0 ? (
              <div className="rounded bg-background/45 ring-1 ring-border/20" data-testid="state-raw-diff">
                <button
                  type="button"
                  onClick={() => setRawOpen((value) => !value)}
                  className="flex w-full items-center gap-2 px-2 py-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
                  aria-expanded={rawOpen}
                  data-testid="state-raw-diff-toggle"
                >
                  <ChevronDown className={cn('h-3 w-3 flex-none transition-transform', rawOpen ? '' : '-rotate-90')} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{t('inspector.trace.rawDiff')}</span>
                  <span className="font-mono">{diff.length}</span>
                </button>
                {rawOpen ? <div className="space-y-1 border-t border-border/25 p-1.5" data-testid="state-raw-diff-view">
                  {diff.map((item) => <DiffRow key={`${item.path}-${item.before}-${item.after}`} item={item} />)}
                </div> : null}
              </div>
            ) : null}
          </div>
        </div> : null}
      </div>
    </div>
  )
}

function DiffSummaryGroup({ group }: { group: StateDiffSummaryGroup }): JSX.Element {
  return (
    <div className="min-w-0 rounded bg-background/65 ring-1 ring-border/20" data-testid={`state-diff-summary-${group.id}`}>
      <div className="border-b border-border/20 px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">{group.title}</div>
      <div className="divide-y divide-border/15">
        {group.items.map((item) => <DiffSummaryItem key={`${item.label}-${item.value}`} item={item} />)}
      </div>
    </div>
  )
}

function DiffSummaryItem({ item }: { item: StateDiffSummaryItem }): JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(5.5rem,0.8fr)_minmax(0,1.2fr)] gap-2 px-2 py-1 font-mono text-[10px]">
      <span className={cn('min-w-0 truncate', diffSummaryTone(item.tone))} title={item.label}>{item.label}</span>
      <span className="min-w-0 truncate text-foreground" title={item.value}>{item.value}</span>
      {item.detail ? <span className="col-span-2 min-w-0 truncate text-muted-foreground" title={item.detail}>{item.detail}</span> : null}
    </div>
  )
}

function diffSummaryTone(tone: StateDiffSummaryItem['tone']): string {
  if (tone === 'added') return 'text-emerald-700 dark:text-emerald-300'
  if (tone === 'removed') return 'text-rose-700 dark:text-rose-300'
  if (tone === 'changed') return 'text-amber-700 dark:text-amber-300'
  return 'text-muted-foreground'
}

function DiffRow({ item }: { item: StateDiff }): JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(4.75rem,0.8fr)_minmax(0,1.2fr)] items-center gap-1 rounded bg-background/65 px-1.5 py-1 font-mono text-[10px] ring-1 ring-border/20">
      <span className="min-w-0 truncate text-muted-foreground" title={item.path}>{item.path}</span>
      <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
        <span className="truncate rounded bg-muted/45 px-1 text-muted-foreground" title={item.before}>{item.before}</span>
        <span className="text-muted-foreground">→</span>
        <span className="truncate rounded bg-primary/10 px-1 text-foreground" title={item.after}>{item.after}</span>
      </span>
    </div>
  )
}

function TimelineMinimap({ entries, selectedSeq, onSelect }: { entries: readonly TimelineEntry[]; selectedSeq: number | null; onSelect(seq: number | null): void }): JSX.Element {
  return (
    <div className="my-1 flex min-h-0 w-4 flex-col rounded-md bg-background/60 p-1 ring-1 ring-border/25" data-testid="timeline-minimap">
      {entries.map((entry) => {
        const cat = primaryCategory(entry)
        return (
          <button
            key={entry.seq}
            type="button"
            onClick={() => onSelect(entry.seq)}
            className={cn('mx-auto my-px min-h-[4px] w-1.5 flex-1 rounded-full opacity-70 transition-all hover:w-2 hover:opacity-100', minimapTone(cat), selectedSeq === entry.seq ? 'w-2 opacity-100 ring-1 ring-primary/70' : '')}
            title={`#${entry.seq} ${entry.event.kind}`}
            aria-label={`select replay cursor ${entry.seq}`}
            aria-current={selectedSeq === entry.seq ? 'true' : undefined}
            data-testid="timeline-minimap-item"
          />
        )
      })}
    </div>
  )
}


function eventSummary(event: AgentEvent, priorCallLlm: PriorCallLlm | null): string {
  switch (event.kind) {
    case 'user_message':
      return event.text ? summarizeTextForCard(event.text) : summarizeContentForCard(event.content ?? [])
    case 'llm_response':
      return `${summarizeContentForCard(event.message.content)}${priorCallLlm ? ` · response to call_llm #${priorCallLlm.seq}` : ''}`
    case 'tool_result':
      return `${event.ok ? 'ok' : 'error'} · ${event.content.length} chars`
    case 'user_approve':
      return `approved ${event.callId}`
    case 'user_reject':
      return `rejected ${event.callId}${event.reason ? ` · ${event.reason}` : ''}`
    case 'llm_error':
      return event.error
    case 'messages_replaced':
      return event.reason === 'compaction'
        ? `compaction · ${event.replaceRange.start} → ${event.replaceRange.end} · ${event.replacementMessages.length} replacement message(s)`
        : `messages replaced · ${event.reason}`
    case 'approval_mode_changed':
      return `approval mode ${event.mode}`
    case 'cwd_changed':
      return event.cwd
    case 'cancel':
      return 'cancel requested'
    case 'clear':
      return 'session context cleared'
  }
}

function summarizeContent(content: readonly MessageContent[]): string {
  if (content.length === 0) return 'empty message'
  return content.map((c) => {
    if (c.type === 'text') return c.text.slice(0, 120)
    if (c.type === 'tool_call') return `tool_call ${c.name}`
    if (c.type === 'tool_result') return `tool_result ${c.ok ? 'ok' : 'error'} ${c.content.slice(0, 80)}`
    if (c.type === 'image') return `image ${c.source.kind}`
    if (c.type === 'thinking') return 'thinking block'
    return 'content'
  }).join(' · ')
}

function summarizeContentForCard(content: readonly MessageContent[]): string {
  if (content.length === 0) return 'empty message'
  const textChars = content
    .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
    .reduce((sum, c) => sum + c.text.replace(/\s+/g, ' ').trim().length, 0)
  const toolCalls = content.filter((c): c is Extract<MessageContent, { type: 'tool_call' }> => c.type === 'tool_call')
  const toolResults = content.filter((c): c is Extract<MessageContent, { type: 'tool_result' }> => c.type === 'tool_result')
  const images = content.filter((c) => c.type === 'image').length
  const thinking = content.filter((c) => c.type === 'thinking').length

  const parts: string[] = []
  if (textChars > 0) parts.push(`text ${textChars} chars`)
  if (toolCalls.length > 0) parts.push(`tool calls ${toolCalls.length}: ${compactNameCounts(toolCalls.map((c) => c.name), 2)}`)
  if (toolResults.length > 0) {
    const ok = toolResults.filter((c) => c.ok).length
    const err = toolResults.length - ok
    parts.push(`tool results ${toolResults.length}${err > 0 ? ` (${err} error)` : ''}`)
  }
  if (images > 0) parts.push(`images ${images}`)
  if (thinking > 0) parts.push(`thinking ${thinking}`)
  return compactCardSummary(parts.join(' · ') || `${content.length} content blocks`)
}

function summarizeTextForCard(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return 'empty text'
  return compact.length > 48 ? `text ${compact.length} chars` : compactCardSummary(compact)
}

function compactNameCounts(names: readonly string[], limit: number): string {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = entries.slice(0, limit).map(([name, count]) => count > 1 ? `${name} x${count}` : name)
  const remaining = entries.length - shown.length
  return remaining > 0 ? `${shown.join(', ')} +${remaining}` : shown.join(', ')
}

function compactCardSummary(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact
}

function messageRoleTone(role: Message['role']): string {
  if (role === 'user') return 'text-sky-600 dark:text-sky-300'
  if (role === 'assistant') return 'text-violet-600 dark:text-violet-300'
  if (role === 'tool') return 'text-emerald-600 dark:text-emerald-300'
  return 'text-amber-600 dark:text-amber-300'
}

function roleCounts(messages: readonly Message[]): string {
  const counts = new Map<Message['role'], number>()
  for (const message of messages) counts.set(message.role, (counts.get(message.role) ?? 0) + 1)
  return [...counts.entries()].map(([role, count]) => `${role} ${count}`).join(', ') || 'none'
}

function describeSystemInjection(call: LlmCall): string {
  const provider = call.trace ? providerFromTrace(call.trace) : 'unknown'
  const firstSystem = call.effect.messages.find((message) => message.role === 'system')
  const hasProviderSystem = call.trace ? providerBodyHasKey(call.trace.request.body, 'system') : false
  if (provider === 'anthropic' && hasProviderSystem) {
    return firstSystem
      ? 'system message or config prompt is folded into Anthropic top-level body.system'
      : 'config prompt is sent as Anthropic top-level body.system'
  }
  if (provider === 'openai') {
    return 'system prompt is sent as an OpenAI-compatible system message when configured'
  }
  if (firstSystem) return 'kernel request includes at least one system message'
  return 'no system prompt visible in captured request data'
}

function adapterTransformSummary(provider: string): string {
  if (provider === 'anthropic') {
    return 'systemPrompt -> body.system; messages -> body.messages; tool_call -> tool_use; tool_result -> tool_result; ToolSchema[] -> body.tools'
  }
  if (provider === 'openai') {
    return 'systemPrompt -> system message; messages -> body.messages; tool_call/tool_result -> OpenAI-compatible tool messages; ToolSchema[] -> tools'
  }
  return 'HTTP trace captured; exact adapter output is shown in API Request'
}

function apiAdapterLabel(provider: string): string {
  if (provider === 'anthropic') return 'Anthropic Messages API'
  if (provider === 'openai') return 'OpenAI-compatible Chat API'
  if (provider === 'kernel') return 'not captured'
  return provider
}

function redactedApiRequest(trace: LLMTrace): LLMTrace['request'] {
  return redactLlmTrace(trace).request
}


function providerArrayLength(body: unknown, key: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'not present'
  const value = (body as Record<string, unknown>)[key]
  return Array.isArray(value) ? String(value.length) : 'not present'
}

function llmResponseSummary(call: LlmCall): string {
  if (call.error) return call.error.error
  if (!call.response) return 'pending'
  return summarizeContent(call.response.message.content)
}

function llmResponseCardSummary(call: LlmCall): string {
  if (call.error) return `error ${call.error.error.length} chars`
  if (!call.response) return 'pending'
  return summarizeContentForCard(call.response.message.content)
}

function formatTraceDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'not captured'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function toolResultLabel(call: ToolCallLifecycle): string {
  if (!call.result) return call.rejectedSeq ? 'rejected' : 'pending'
  return `${call.result.ok ? 'ok' : 'error'} · ${call.result.content.length} bytes`
}

function toolLifecycleSummary(call: ToolCallLifecycle): string {
  const parts: string[] = []
  if (call.requestedSeq) parts.push(`requested #${call.requestedSeq}`)
  if (call.approvedSeq) parts.push(`approved #${call.approvedSeq}`)
  if (call.rejectedSeq) parts.push(`rejected #${call.rejectedSeq}`)
  if (call.resultSeq) parts.push(`result #${call.resultSeq}`)
  return parts.join(' · ') || 'lifecycle not recorded'
}

function toolInputSummary(input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? `path ${input.path}` : null
  const cmd = typeof input.cmd === 'string' ? `cmd ${input.cmd}` : null
  const query = typeof input.query === 'string' ? `query ${input.query}` : null
  return path ?? cmd ?? query ?? JSON.stringify(input).slice(0, 140)
}

function shortStatus(status: AgentState['status'] | undefined): string {
  if (!status) return 'none'
  if (status === 'executing_tools') return 'executing'
  if (status === 'awaiting_approval') return 'approval'
  return status
}

function statusTone(status: AgentState['status'] | undefined): string | undefined {
  if (status === 'error') return 'text-rose-600 dark:text-rose-300'
  if (status === 'awaiting_approval') return 'text-amber-600 dark:text-amber-300'
  if (status === 'executing_tools') return 'text-emerald-600 dark:text-emerald-300'
  if (status === 'thinking') return 'text-violet-600 dark:text-violet-300'
  return undefined
}

function healthTone(tone: RunHealthItem['tone']): string {
  if (tone === 'ok') return 'text-emerald-600 dark:text-emerald-300'
  if (tone === 'warn') return 'text-amber-600 dark:text-amber-300'
  if (tone === 'error') return 'text-rose-600 dark:text-rose-300'
  return 'text-muted-foreground'
}

function primaryCategory(entry: TimelineEntry): TraceCategory {
  const cats = eventCategories(entry)
  return TRACE_CATEGORY_ORDER.find((cat) => cats.has(cat)) ?? 'system'
}

function minimapTone(cat: TraceCategory): string {
  if (cat === 'user') return 'bg-sky-500/70 hover:bg-sky-500'
  if (cat === 'llm') return 'bg-violet-500/70 hover:bg-violet-500'
  if (cat === 'tool') return 'bg-emerald-500/70 hover:bg-emerald-500'
  if (cat === 'approval') return 'bg-amber-500/70 hover:bg-amber-500'
  return 'bg-muted-foreground/50 hover:bg-muted-foreground'
}

function teachingText(entry: TimelineEntry, flow?: StateFlowStep): string {
  const inbound = inboundOf(entry.event)
  const effects = entry.effects.length > 0
    ? entry.effects.map((effect) => `${effect.kind} -> ${effectTarget(effect).target}`).join(', ')
    : 'no external effects'
  const transition = flow ? `${flow.from} -> ${flow.to}` : 'state transition not classified'
  return `${inbound.source} sends ${entry.event.kind}; state machine moves ${transition}; output actions: ${effects}.`
}

function llmCallModel(call: LlmCall): string {
  return modelFromTrace(call.trace) ?? call.model ?? 'model unknown'
}

function llmCallProvider(call: LlmCall): string {
  if (!call.trace) return providerFromModel(llmCallModel(call)) ?? 'kernel'
  return providerFromTrace(call.trace)
}

function modelFromTrace(trace: LLMTrace | undefined): string | null {
  if (!trace) return null
  if (typeof trace.model === 'string' && trace.model.length > 0) return trace.model
  const body = trace.request.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const model = (body as Record<string, unknown>).model
    if (typeof model === 'string' && model.length > 0) return model
  }
  return null
}

function providerFromTrace(trace: LLMTrace): string {
  const provider = trace.provider
  if (provider && provider !== 'unknown') return provider
  const model = modelFromTrace(trace)
  const fromModel = providerFromModel(model ?? undefined)
  if (fromModel) return fromModel
  const url = trace.request.url.toLowerCase()
  if (url.includes('anthropic')) return 'anthropic'
  if (url.includes('openai')) return 'openai'
  return 'unknown'
}

function providerFromModel(model: string | undefined): string | null {
  if (!model) return null
  const normalized = model.toLowerCase()
  if (normalized.includes('claude')) return 'anthropic'
  if (normalized.includes('gpt')) return 'openai'
  return null
}

function MemoryEntryRow({ entry }: { entry: { key: string; content: string; updatedAt: string } }): JSX.Element {
  return (
    <div className="rounded bg-muted/60 p-2 ring-1 ring-border/30">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">{entry.key}</span>
        {entry.updatedAt && entry.updatedAt !== '1970-01-01T00:00:00.000Z' ? (
          <span className="flex-none text-[10px] text-muted-foreground">{new Date(entry.updatedAt).toLocaleString()}</span>
        ) : null}
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{entry.content}</pre>
    </div>
  )
}
