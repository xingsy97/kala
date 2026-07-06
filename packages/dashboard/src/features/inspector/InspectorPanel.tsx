import { useMemo, useState } from 'react'
import {
  Activity,
  Archive,
  Bot,
  Brain,
  CheckCircle2,
  Database,
  GitBranch,
  Hammer,
  History,
  MessageSquare,
  SearchCode,
  ServerCog,
  XCircle,
} from 'lucide-react'
import type {
  AgentConfig,
  AgentEvent,
  AgentState,
  CallLlmEffect,
  CallToolEffect,
  Effect,
  Message,
  MessageContent,
  ToolSchema,
} from '@agent-kernel/kernel'
import type { LLMTrace } from '@agent-kernel/shared'

import type { TimelineEntry } from '../../session.js'
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

type Props = {
  state: AgentState | null
  config?: AgentConfig | null
  timeline: readonly TimelineEntry[]
  visibleMessagesCount?: number
  onFork?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
}

type TraceView = 'reducer' | 'llm' | 'tools'
type RuntimeView = 'state' | 'tools' | 'memory'
type SidebarView = 'debugger' | 'trace'
type LlmDetailView = 'assembly' | 'context' | 'payload' | 'response'
type ContextProportion = {
  kind: 'system' | 'messages' | 'tools'
  label: string
  bytes: number
  percent: number
  color: string
}
type DetailSelection =
  | { kind: 'event'; entry: TimelineEntry; priorCallLlm: PriorCallLlm | null; flow?: StateFlowStep }
  | { kind: 'llm'; call: LlmCall }
  | { kind: 'tool'; call: ToolCallLifecycle }
  | null

type PriorCallLlm = { seq: number; effect: CallLlmEffect }

type LlmCall = {
  id: string
  requestSeq: number
  responseSeq?: number
  effect: CallLlmEffect
  response?: Extract<AgentEvent, { kind: 'llm_response' }>
  error?: Extract<AgentEvent, { kind: 'llm_error' }>
  trace?: LLMTrace
  model?: string
}

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

export function InspectorPanel({
  state,
  config,
  timeline,
  visibleMessagesCount,
  onFork,
  onJumpToMessage,
}: Props): JSX.Element {
  const [sidebarView, setSidebarView] = useState<SidebarView>('debugger')
  const [traceView, setTraceView] = useState<TraceView>('reducer')
  const [runtimeView, setRuntimeView] = useState<RuntimeView>('state')
  const [selected, setSelected] = useState<DetailSelection>(null)
  const [pendingForkSeq, setPendingForkSeq] = useState<number | null>(null)

  const flow = useMemo(() => stateFlow(timeline), [timeline])
  const llmCalls = useMemo(() => buildLlmCalls(timeline), [timeline])
  const toolCalls = useMemo(() => buildToolCalls(timeline), [timeline])

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
      <SidebarTabs value={sidebarView} onChange={setSidebarView} />

      {sidebarView === 'debugger' ? (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="debugger-sidebar-tabpanel">
          <Overview state={state} config={config} timeline={timeline} visibleMessagesCount={visibleMessagesCount} />
          <div className="min-h-0 flex-1">
            <RuntimeSection
              view={runtimeView}
              onViewChange={setRuntimeView}
              state={state}
              config={config}
              toolCalls={toolCalls}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1" data-testid="trace-sidebar-tabpanel">
          <TraceSection
            view={traceView}
            onViewChange={setTraceView}
            timeline={timeline}
            flow={flow}
            llmCalls={llmCalls}
            toolCalls={toolCalls}
            messagesCount={visibleMessagesCount ?? state?.messages.length ?? 0}
            selected={selected}
            onSelect={setSelected}
            onForkRequest={onFork ? (seq) => setPendingForkSeq(seq) : undefined}
            onJumpToMessage={onJumpToMessage}
          />
        </div>
      )}

      <DetailDialog
        selection={selected}
        timeline={timeline}
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
            <AlertDialogTitle>Fork session?</AlertDialogTitle>
            <AlertDialogDescription>
              A new session will branch at cursor{' '}
              <span className="font-mono text-foreground">{pendingForkSeq ?? ''}</span>. Its
              history up to this row is copied, then the new session diverges.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmFork} data-testid="confirm-fork-button">
              Fork
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SidebarTabs({ value, onChange }: { value: SidebarView; onChange(view: SidebarView): void }): JSX.Element {
  return (
    <div className="flex-none bg-card px-3 pb-3" data-testid="inspector-sidebar-tabs">
      <div className="grid grid-cols-2 rounded bg-sidebar p-0.5 text-xs">
        <button
          type="button"
          onClick={() => onChange('debugger')}
          className={cn('rounded px-2 py-1.5 font-medium transition-colors', value === 'debugger' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground')}
          data-testid="inspector-sidebar-tab-debugger"
          aria-pressed={value === 'debugger'}
        >
          Debugger
        </button>
        <button
          type="button"
          onClick={() => onChange('trace')}
          className={cn('rounded px-2 py-1.5 font-medium transition-colors', value === 'trace' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground')}
          data-testid="inspector-sidebar-tab-trace"
          aria-pressed={value === 'trace'}
        >
          Trace View
        </button>
      </div>
    </div>
  )
}

function DebuggerHeader({
  state,
  config,
  timeline,
  visibleMessagesCount,
}: {
  state: AgentState | null
  config?: AgentConfig | null
  timeline: readonly TimelineEntry[]
  visibleMessagesCount?: number
}): JSX.Element {
  const model = modelFromTimeline(timeline) ?? 'model unset'
  const cwd = state?.cwd ?? 'cwd unset'
  return (
    <div className="flex-none bg-card px-3 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <ServerCog className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="font-semibold text-foreground">Agent Kernel Debugger</span>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              #{state?.cursor ?? timeline.at(-1)?.seq ?? 0}
            </span>
          </div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">
            {state?.status ?? 'no state'}  -  approval {state?.approvalMode ?? 'n/a'}  -  {model}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={cwd}>
            cwd {cwd}
          </div>
        </div>
      </div>
      <div className="sr-only">
        {visibleMessagesCount ?? state?.messages.length ?? 0} visible messages
        {config?.tools.length ?? 0} tools
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
  const contextLimit = config?.contextLimit
  const context = contextLimit
    ? `${state?.usage.inputTokens ?? 0} / ${contextLimit}`
    : `${state?.usage.inputTokens ?? 0} input`
  const pending = state?.pendingCalls.find((c) => c.status !== 'rejected')
  return (
    <section className="flex-none bg-card px-3 pb-3" aria-label="debugger overview">
      <div className="grid grid-cols-2 gap-1.5 text-xs xl:grid-cols-4">
        <Metric label="Status" value={shortStatus(state?.status)} tone={statusTone(state?.status)} />
        <Metric label="Events" value={String(timeline.length)} />
        <Metric label="Context" value={context} />
        <Metric label="Pending" value={pending?.name ?? 'none'} tone={pending ? 'text-amber-600 dark:text-amber-300' : undefined} />
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
  onViewChange,
  timeline,
  flow,
  llmCalls,
  toolCalls,
  messagesCount,
  selected,
  onSelect,
  onForkRequest,
  onJumpToMessage,
}: {
  view: TraceView
  onViewChange(view: TraceView): void
  timeline: readonly TimelineEntry[]
  flow: readonly StateFlowStep[]
  llmCalls: readonly LlmCall[]
  toolCalls: readonly ToolCallLifecycle[]
  messagesCount: number
  selected: DetailSelection
  onSelect(selection: DetailSelection): void
  onForkRequest?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
}): JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="trace view">
      <SectionHeader icon={History} title="Trace View">
        <Segmented<TraceView>
          value={view}
          onChange={onViewChange}
          options={[
            ['reducer', 'Reducer Trace'],
            ['llm', 'LLM Calls'],
            ['tools', 'Tool Calls'],
          ]}
          testId="trace-view-switch"
        />
      </SectionHeader>
      {view === 'reducer' ? (
        <ReducerTrace
          timeline={timeline}
          flow={flow}
          messagesCount={messagesCount}
          selected={selected}
          onSelect={onSelect}
          onForkRequest={onForkRequest}
          onJumpToMessage={onJumpToMessage}
        />
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
  selected,
  onSelect,
  onForkRequest,
  onJumpToMessage,
}: {
  timeline: readonly TimelineEntry[]
  flow: readonly StateFlowStep[]
  messagesCount: number
  selected: DetailSelection
  onSelect(selection: DetailSelection): void
  onForkRequest?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
}): JSX.Element {
  if (timeline.length === 0) {
    return <EmptyBlock label="No reducer events yet." />
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-0.5 px-2 pb-3" data-testid="reducer-trace-list">
        {timeline.map((entry, i) => {
          const priorCallLlm = findPriorCallLlm(timeline, i)
          const flowStep = flow.find((s) => s.seq === entry.seq)
          const isSelected = selected?.kind === 'event' && selected.entry.seq === entry.seq
          return (
            <ReducerTraceRow
              key={entry.seq}
              entry={entry}
              flow={flowStep}
              priorCallLlm={priorCallLlm}
              selected={isSelected}
              messageIndex={messageIndexFor(timeline, i, messagesCount)}
              onSelect={() => onSelect({ kind: 'event', entry, priorCallLlm, flow: flowStep })}
              onForkRequest={onForkRequest}
              onJumpToMessage={onJumpToMessage}
            />
          )
        })}
      </div>
    </ScrollArea>
  )
}

function ReducerTraceRow({
  entry,
  flow,
  priorCallLlm,
  selected,
  messageIndex,
  onSelect,
  onForkRequest,
  onJumpToMessage,
}: {
  entry: TimelineEntry
  flow?: StateFlowStep
  priorCallLlm: PriorCallLlm | null
  selected: boolean
  messageIndex: number | null
  onSelect(): void
  onForkRequest?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
}): JSX.Element {
  const inbound = inboundOf(entry.event)
  const jumpable = messageIndex !== null && onJumpToMessage !== undefined
  const effectLabels = entry.effects.map((eff, i) => ({ key: `${eff.kind}-${i}`, effect: eff, target: effectTarget(eff) }))
  return (
    <div
      className={cn(
        'group relative rounded px-2 py-1.5 text-xs transition-colors',
        selected ? 'bg-card' : 'hover:bg-card/70',
      )}
      data-testid="timeline-row"
    >
      {selected ? <div className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded bg-primary" /> : null}
      <button
        type="button"
        onClick={onSelect}
        className="grid w-full grid-cols-[2.55rem_minmax(0,1fr)] gap-x-1.5 text-left"
        data-testid="timeline-row-header"
        aria-label={`inspect timeline event ${entry.seq}`}
      >
        <span className="pt-px text-right font-mono text-[10px] text-muted-foreground">#{entry.seq}</span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('w-14 flex-none font-mono text-[10px]', inbound.tone)}>{inbound.source}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{entry.event.kind}</span>
            {flow ? (
              <span className="hidden flex-none font-mono text-[10px] text-muted-foreground xl:inline">
                {flow.from}  -  {flow.to}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[10px] leading-4 text-muted-foreground">
            {eventSummary(entry.event, priorCallLlm)}
          </span>
          {effectLabels.length > 0 ? (
            <span className="mt-0.5 flex min-w-0 flex-wrap gap-1">
              {effectLabels.map(({ key, effect, target }) => (
                <span key={key} className="rounded bg-background/80 px-1.5 py-px font-mono text-[9px] leading-4 text-muted-foreground ring-1 ring-border/30">
                  <span className={target.tone}>{target.target}</span>  -  {effect.kind}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </button>
      <div className="mt-0.5 flex justify-end gap-1 pl-10 opacity-100 xl:opacity-0 xl:transition-opacity xl:group-hover:opacity-100 xl:group-focus-within:opacity-100">
        {jumpable ? (
          <MiniAction onClick={() => onJumpToMessage!(messageIndex!)} title={`scroll chat to message #${messageIndex}`}>
            jump chat
          </MiniAction>
        ) : null}
        {onForkRequest ? (
          <MiniAction onClick={() => onForkRequest(entry.seq)} title={`fork a new session at cursor ${entry.seq}`} ariaLabel={`fork at cursor ${entry.seq}`}>
            <GitBranch className="h-3 w-3" aria-hidden="true" /> fork
          </MiniAction>
        ) : null}
        <MiniAction onClick={onSelect} title="inspect raw JSON">inspect json</MiniAction>
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
  if (calls.length === 0) return <EmptyBlock label="No LLM calls emitted yet." />
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-1 px-2 pb-3" data-testid="llm-calls-list">
        {calls.map((call) => {
          const isSelected = selected?.kind === 'llm' && selected.call.id === call.id
          const usage = call.response?.usage
          const status = call.error ? 'error' : call.response ? String(call.trace?.response?.status ?? 'ok') : 'pending'
          const provider = llmCallProvider(call)
          const model = llmCallModel(call)
          return (
            <button
              key={call.id}
              type="button"
              onClick={() => onSelect({ kind: 'llm', call })}
              className={cn('relative w-full rounded px-2 py-1.5 text-left text-xs transition-colors', isSelected ? 'bg-card' : 'hover:bg-card/70')}
              data-testid="llm-call-row"
            >
              {isSelected ? <div className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded bg-primary" /> : null}
              <div className="flex min-w-0 items-center gap-2">
                <span className="w-20 flex-none font-mono text-[11px] text-muted-foreground">#{call.requestSeq}  -  {call.responseSeq ? `#${call.responseSeq}` : 'pending'}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-violet-600 dark:text-violet-300">{provider} / {model}</span>
                <span className={cn('flex-none font-mono text-[11px]', call.error ? 'text-rose-600 dark:text-rose-300' : 'text-muted-foreground')}>{status}</span>
              </div>
              <div className="mt-1 truncate pl-20 text-[11px] text-muted-foreground">
                request {call.effect.messages.length} messages  -  {call.effect.tools.length} tools  -  response {llmResponseSummary(call)}
              </div>
              <div className="mt-1 truncate pl-20 font-mono text-[10px] text-muted-foreground">
                usage {usage ? `${usage.inputTokens}/${usage.outputTokens}` : 'not reported'}  -  provider trace {call.trace ? 'captured' : 'not captured'}
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
  if (calls.length === 0) return <EmptyBlock label="No tool calls emitted yet." />
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-1 px-2 pb-3" data-testid="tool-calls-list">
        {calls.map((call) => {
          const isSelected = selected?.kind === 'tool' && selected.call.callId === call.callId
          return (
            <button
              key={call.callId}
              type="button"
              onClick={() => onSelect({ kind: 'tool', call })}
              className={cn('relative w-full rounded px-2 py-1.5 text-left text-xs transition-colors', isSelected ? 'bg-card' : 'hover:bg-card/70')}
              data-testid="tool-call-row"
            >
              {isSelected ? <div className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded bg-primary" /> : null}
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">{call.callId}</span>
                <span className="flex-none font-mono text-[11px] text-emerald-600 dark:text-emerald-300">{call.name}</span>
                <span className={cn('flex-none font-mono text-[11px]', call.result?.ok === false ? 'text-rose-600 dark:text-rose-300' : 'text-muted-foreground')}>
                  {toolResultLabel(call)}
                </span>
              </div>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">
                {toolLifecycleSummary(call)}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                {toolInputSummary(call.input)}
              </div>
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function RuntimeSection({
  view,
  onViewChange,
  state,
  config,
  toolCalls,
}: {
  view: RuntimeView
  onViewChange(view: RuntimeView): void
  state: AgentState | null
  config?: AgentConfig | null
  toolCalls: readonly ToolCallLifecycle[]
}): JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="runtime objects">
      <SectionHeader icon={Database} title="Runtime Objects">
        <Segmented<RuntimeView>
          value={view}
          onChange={onViewChange}
          options={[
            ['state', 'State'],
            ['tools', 'Tools'],
            ['memory', 'Memory'],
          ]}
          testId="runtime-view-switch"
        />
      </SectionHeader>
      <div className="min-h-0 flex-1 bg-card px-3 pb-3 pt-1">
        {view === 'state' ? (
          <StateRuntime state={state} />
        ) : view === 'tools' ? (
          <ToolsRuntime tools={config?.tools ?? []} toolCalls={toolCalls} />
        ) : (
          <MemoryRuntime state={state} />
        )}
      </div>
    </section>
  )
}

function StateRuntime({ state }: { state: AgentState | null }): JSX.Element {
  const [jsonOpen, setJsonOpen] = useState(false)
  if (!state) return <EmptyBlock label="No AgentState loaded." />
  const pendingCalls = state.pendingCalls.map((c) => `${c.name}  -  ${c.status}`)
  const memoryKeys = state.memory?.map((entry) => entry.key) ?? []
  return (
    <>
      <ScrollArea className="h-full">
        <div className="space-y-2 pb-1" data-testid="state-runtime">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-foreground">AgentState</div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={state.sessionId}>{state.sessionId}</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setJsonOpen(true)}>
              View JSON
            </Button>
          </div>

          <div className="grid gap-2 xl:grid-cols-2">
            <StateGroup
              title="Core"
              rows={[
                ['status', state.status],
                ['cursor', String(state.cursor)],
                ['approval', state.approvalMode],
                ['cwd', state.cwd ?? 'not set'],
              ]}
            />
            <StateGroup
              title="Workload"
              rows={[
                ['messages', String(state.messages.length)],
                ['todos', String(state.todos.length)],
                ['pending', pendingCalls.length > 0 ? pendingCalls.join(', ') : 'none'],
                ['context pressure', state.contextPressureLevel ?? 'n/a'],
              ]}
            />
            <StateGroup
              title="Usage"
              rows={[
                ['input', String(state.usage.inputTokens)],
                ['output', String(state.usage.outputTokens)],
                ['cache create', String(state.usage.cacheCreationTokens ?? 0)],
                ['cache read', String(state.usage.cacheReadTokens ?? 0)],
                ['cost', state.usage.costUsd ? `$${state.usage.costUsd.toFixed(4)}` : '$0'],
              ]}
            />
            <StateGroup
              title="Memory"
              rows={[
                ['session entries', String(state.memory?.length ?? 0)],
                ['keys', memoryKeys.length > 0 ? memoryKeys.join(', ') : 'none'],
              ]}
            />
          </div>
        </div>
      </ScrollArea>
      <Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
        <DialogContent className="h-[86vh] max-w-5xl overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader className="bg-card px-4 py-3">
            <DialogTitle className="text-base">AgentState JSON</DialogTitle>
            <DialogDescription>Full raw runtime state for the current session.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 bg-background p-4" data-testid="agent-state-json-dialog">
            <ScrollArea className="h-full">
              <JsonBlock label="Full AgentState JSON" value={state} collapsed={2} />
            </ScrollArea>
          </div>
          <DialogFooter className="bg-card px-4 py-3">
            <DialogClose asChild>
              <Button variant="outline" className="mt-0">Close</Button>
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

function ToolsRuntime({ tools, toolCalls }: { tools: readonly ToolSchema[]; toolCalls: readonly ToolCallLifecycle[] }): JSX.Element {
  const [selectedName, setSelectedName] = useState<string | null>(tools[0]?.name ?? null)
  const selectedTool = tools.find((t) => t.name === selectedName) ?? tools[0]
  if (tools.length === 0) return <EmptyBlock label="No tools registered for this session." />
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
              {isSkillTool(tool) ? (
                <span className="flex-none rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">skill</span>
              ) : null}
              <span className={cn('flex-none text-[10px]', tool.requiresApproval ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300')}>
                {tool.requiresApproval ? 'gated' : 'auto'}
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
                    <span className="flex-none rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">Skill loader</span>
                  ) : null}
                </div>
                <div className="mt-1 text-muted-foreground">{selectedTool.requiresApproval ? 'approval required' : 'auto allowed'}</div>
                <p className="mt-2 text-muted-foreground">{selectedTool.description || 'No description provided.'}</p>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Recent calls</div>
                {recent.length > 0 ? (
                  <ul className="space-y-1">
                    {recent.map((call) => (
                      <li key={`${call.callId}-${call.resultSeq ?? 'pending'}`} className="truncate rounded bg-muted/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        #{call.requestedSeq ?? '?'} {toolResultLabel(call)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-[11px] text-muted-foreground">No calls in this timeline.</div>
                )}
              </div>
              <JsonBlock label={`Input schema  -  ${selectedTool.name}`} value={selectedTool.inputSchema} collapsed={2} className="[&>div:last-child]:max-h-56 [&_[data-radix-scroll-area-viewport]]:max-h-56" />
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

function MemoryRuntime({ state }: { state: AgentState | null }): JSX.Element {
  const memory = state?.memory ?? []
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
              <div className="text-muted-foreground">No session memory entries.</div>
            )
          ) : (
            <div className="space-y-2 text-muted-foreground">
              <div className="font-mono text-foreground">{scope}</div>
              <p>{scope} memory is executor-owned disk state. The kernel keeps only session memory in AgentState.</p>
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
  onOpenChange,
}: {
  selection: DetailSelection
  timeline: readonly TimelineEntry[]
  onOpenChange(open: boolean): void
}): JSX.Element {
  const title = detailTitle(selection)
  const description = detailDescription(selection)
  return (
    <Dialog open={selection !== null} onOpenChange={onOpenChange}>
      <DialogContent className="h-[86vh] max-w-5xl overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader className="bg-card px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <SearchCode className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 bg-background p-4">
          {selection ? (
            selection.kind === 'llm' ? (
              <LlmDetail call={selection.call} />
            ) : selection.kind === 'tool' ? (
              <ToolDetail call={selection.call} />
            ) : selection.entry.event.kind === 'compact_replaced' ? (
              <CompactDetail entry={selection.entry} timeline={timeline} />
            ) : (
              <EventDetail selection={selection} />
            )
          ) : null}
        </div>
        <DialogFooter className="bg-card px-4 py-3">
          <DialogClose asChild>
            <Button variant="outline" className="mt-0">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function detailTitle(selection: DetailSelection): string {
  if (!selection) return 'Selected Detail'
  if (selection.kind === 'llm') {
    return `LLM Call #${selection.call.requestSeq}  -  ${selection.call.responseSeq ? `#${selection.call.responseSeq}` : 'pending'}`
  }
  if (selection.kind === 'tool') return `Tool Call  -  ${selection.call.name}`
  return `Timeline Event #${selection.entry.seq}`
}

function detailDescription(selection: DetailSelection): string {
  if (!selection) return 'Select a reducer event, LLM call, or tool call to inspect raw data.'
  if (selection.kind === 'llm') {
    return 'Kernel request, provider request/response trace, and parsed kernel response.'
  }
  if (selection.kind === 'tool') {
    return `${selection.call.callId}  -  ${toolLifecycleSummary(selection.call)}`
  }
  return `${selection.entry.event.kind}  -  reducer input, emitted effects, and raw JSON.`
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
        <JsonBlock label={`Event JSON  -  ${selection.entry.event.kind}`} value={selection.entry.event} collapsed={2} />
        {selection.entry.effects.map((eff, i) => (
          <JsonBlock key={i} label={`Effect JSON  -  ${eff.kind}`} value={eff} collapsed={2} />
        ))}
      </div>
    </ScrollArea>
  )
}

function LlmDetail({ call }: { call: LlmCall }): JSX.Element {
  const [view, setView] = useState<LlmDetailView>('assembly')
  const provider = llmCallProvider(call)
  const model = llmCallModel(call)
  const kernelRequest = {
    callSeq: call.requestSeq,
    model: model === 'model unknown' ? null : model,
    messages: call.effect.messages,
    tools: call.effect.tools,
  }
  const parsedResponse = call.response
    ? { responseSeq: call.responseSeq, event: call.response }
    : call.error
      ? { responseSeq: call.responseSeq, event: call.error }
      : { status: 'pending' }
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="llm-detail">
      <div className="flex flex-none items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">LLM Message Assembly</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {provider} / {model}
          </div>
        </div>
        <Segmented<LlmDetailView>
          value={view}
          onChange={setView}
          options={[
            ['assembly', 'Assembly'],
            ['context', 'Context'],
            ['payload', 'Provider'],
            ['response', 'Response'],
          ]}
          testId="llm-detail-view-switch"
        />
      </div>
      {view === 'assembly' ? (
        <LlmAssemblyView call={call} provider={provider} model={model} kernelRequest={kernelRequest} />
      ) : view === 'context' ? (
        <LlmContextView messages={call.effect.messages} tools={call.effect.tools} />
      ) : view === 'payload' ? (
        <ProviderPayloadView call={call} kernelRequest={kernelRequest} />
      ) : (
        <LlmResponseView call={call} parsedResponse={parsedResponse} />
      )}
    </div>
  )
}

function LlmAssemblyView({ call, provider, model, kernelRequest }: { call: LlmCall; provider: string; model: string; kernelRequest: unknown }): JSX.Element {
  const systemInfo = describeSystemInjection(call)
  const toolNames = call.effect.tools.map((tool) => `${tool.name}${tool.requiresApproval ? ' gated' : ' auto'}`)
  const proportions = contextProportions(call)
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-2 pb-1" data-testid="llm-assembly-view">
        <KeyValueTable
          rows={[
            ['call', `#${call.requestSeq}  -  ${call.responseSeq ? `#${call.responseSeq}` : 'pending'}`],
            ['provider', call.trace ? provider : 'kernel only'],
            ['model', model === 'model unknown' ? 'not captured' : model],
            ['kernel messages', String(call.effect.messages.length)],
            ['tools', String(call.effect.tools.length)],
            ['provider trace', call.trace ? 'captured' : 'not captured in this log'],
          ]}
        />
        {!call.trace ? (
          <div className="rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-500/20 dark:text-amber-200">
            Provider HTTP trace is missing for this log entry. The kernel request below is still the exact `call_llm` input; provider request body is only available for calls recorded after trace capture or after the LLM response arrives.
          </div>
        ) : null}
        <ContextProportionBar items={proportions} />
        <AssemblyStep
          index="1"
          title="System Prompt"
          source="AgentConfig.systemPrompt or leading system message"
          result={systemInfo}
        />
        <AssemblyStep
          index="2"
          title="Kernel Messages"
          source="call_llm.messages emitted by the kernel reducer"
          result={`${call.effect.messages.length} messages: ${roleCounts(call.effect.messages)}`}
        />
        <AssemblyStep
          index="3"
          title="Tool Registry"
          source="AgentConfig.tools attached to the call_llm effect"
          result={toolNames.length > 0 ? toolNames.join(', ') : 'no tools sent'}
        />
        <AssemblyStep
          index="4"
          title="Adapter Transform"
          source="host LLM adapter"
          result={adapterTransformSummary(provider)}
        />
        <div className="grid gap-2 xl:grid-cols-2">
          <JsonBlock label={`Kernel Request  -  call_llm @ #${call.requestSeq}`} value={kernelRequest} collapsed={1} className="[&>div:last-child]:max-h-80 [&_[data-radix-scroll-area-viewport]]:max-h-80" />
          {call.trace ? (
            <JsonBlock label="Provider Request Body" value={call.trace.request.body} collapsed={1} className="[&>div:last-child]:max-h-80 [&_[data-radix-scroll-area-viewport]]:max-h-80" />
          ) : (
            <div className="flex min-h-[12rem] items-center justify-center rounded bg-background/70 px-3 text-center text-xs text-muted-foreground ring-1 ring-border/30">
              Provider request body was not captured for this call.
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

function ContextProportionBar({ items }: { items: readonly ContextProportion[] }): JSX.Element {
  const nonZero = items.filter((item) => item.bytes > 0)
  return (
    <div className="rounded bg-background/70 p-3 text-xs ring-1 ring-border/30" data-testid="context-proportion-bar">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-foreground">Context Composition</div>
        <div className="font-mono text-[10px] text-muted-foreground">approx by serialized size</div>
      </div>
      <div className="mt-2 flex h-3 overflow-hidden rounded bg-muted">
        {nonZero.length > 0 ? nonZero.map((item) => (
          <div key={item.kind} className={item.color} style={{ width: `${item.percent}%` }} title={`${item.label}: ${item.percent}%`} />
        )) : <div className="w-full bg-muted" />}
      </div>
      <div className="mt-2 grid gap-1 sm:grid-cols-3">
        {items.map((item) => (
          <div key={item.kind} className="flex min-w-0 items-center gap-1.5">
            <span className={cn('h-2 w-2 flex-none rounded', item.color)} />
            <span className="truncate text-muted-foreground">{item.label}</span>
            <span className="ml-auto flex-none font-mono text-foreground">{item.percent}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function AssemblyStep({ index, title, source, result }: { index: string; title: string; source: string; result: string }): JSX.Element {
  return (
    <div className="rounded bg-background/70 p-3 text-xs ring-1 ring-border/30">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 font-mono text-[10px] text-primary">{index}</span>
        <span className="font-medium text-foreground">{title}</span>
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-[6rem_minmax(0,1fr)]">
        <div className="text-muted-foreground">source</div>
        <div className="min-w-0 font-mono text-foreground">{source}</div>
        <div className="text-muted-foreground">result</div>
        <div className="min-w-0 break-words font-mono text-foreground">{result}</div>
      </div>
    </div>
  )
}

function LlmContextView({ messages, tools }: { messages: readonly Message[]; tools: readonly ToolSchema[] }): JSX.Element {
  const [kind, setKind] = useState<'messages' | 'tools'>('messages')
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="llm-context-view">
      <div className="flex flex-none items-center gap-2">
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          Kernel context includes both conversation messages and the tool registry sent with this LLM call.
        </div>
        <Segmented<'messages' | 'tools'>
          value={kind}
          onChange={setKind}
          options={[
            ['messages', 'Messages'],
            ['tools', 'Tools'],
          ]}
          testId="llm-context-view-switch"
        />
      </div>
      {kind === 'messages' ? <KernelMessagesView messages={messages} /> : <ToolRegistryContextView tools={tools} />}
    </div>
  )
}

function KernelMessagesView({ messages }: { messages: readonly Message[] }): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selected = messages[selectedIndex]
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,0.95fr)_minmax(0,1.05fr)] gap-2" data-testid="kernel-messages-view">
      <ScrollArea className="min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="p-1">
          {messages.map((message, index) => (
            <button
              key={index}
              type="button"
              onClick={() => setSelectedIndex(index)}
              className={cn('flex w-full min-w-0 items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/70', selectedIndex === index ? 'bg-muted' : '')}
              data-testid="kernel-message-row"
            >
              <span className="w-7 flex-none font-mono text-[10px] text-muted-foreground">#{index}</span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn('w-16 flex-none font-mono text-[10px]', messageRoleTone(message.role))}>{message.role}</span>
                  <span className="truncate text-[10px] text-muted-foreground">{message.content.map((block) => block.type).join(', ') || 'empty'}</span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-foreground">{summarizeContent(message.content)}</span>
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
      <ScrollArea className="min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="space-y-2 p-2 text-xs">
          {selected ? (
            <>
              <KeyValueTable
                rows={[
                  ['message', `#${selectedIndex}`],
                  ['role', selected.role],
                  ['blocks', selected.content.map((block) => block.type).join(', ') || 'empty'],
                ]}
              />
              <JsonBlock label={`Kernel Message #${selectedIndex}`} value={selected} collapsed={2} />
            </>
          ) : (
            <EmptyBlock label="No kernel messages in this LLM request." />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function ToolRegistryContextView({ tools }: { tools: readonly ToolSchema[] }): JSX.Element {
  const [selectedName, setSelectedName] = useState<string | null>(tools[0]?.name ?? null)
  const selected = tools.find((tool) => tool.name === selectedName) ?? tools[0]
  if (tools.length === 0) return <EmptyBlock label="No tools were sent with this LLM request." />
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,0.85fr)_minmax(0,1.15fr)] gap-2" data-testid="tool-registry-context-view">
      <ScrollArea className="min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="p-1">
          {tools.map((tool) => (
            <button
              key={tool.name}
              type="button"
              onClick={() => setSelectedName(tool.name)}
              className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/70', selected?.name === tool.name ? 'bg-muted' : '')}
              data-testid="llm-tool-row"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{tool.name}</span>
              {isSkillTool(tool) ? <span className="flex-none rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">skill</span> : null}
              <span className={cn('flex-none text-[10px]', tool.requiresApproval ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300')}>
                {tool.requiresApproval ? 'gated' : 'auto'}
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
      <ScrollArea className="min-h-0 rounded bg-background/70 ring-1 ring-border/30">
        <div className="space-y-2 p-2 text-xs">
          {selected ? (
            <>
              <KeyValueTable
                rows={[
                  ['tool', selected.name],
                  ['approval', selected.requiresApproval ? 'gated' : 'auto'],
                  ['description bytes', String(selected.description.length)],
                ]}
              />
              <p className="rounded bg-muted/50 px-2 py-1.5 text-muted-foreground">{selected.description || 'No description provided.'}</p>
              <JsonBlock label={`Tool Schema  -  ${selected.name}`} value={selected} collapsed={2} />
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}

function ProviderPayloadView({ call, kernelRequest }: { call: LlmCall; kernelRequest: unknown }): JSX.Element {
  if (!call.trace) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 pb-1" data-testid="provider-payload-view">
          <div className="rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-500/20 dark:text-amber-200">
            Provider HTTP trace was not captured for this LLM call. Showing the exact kernel request instead.
          </div>
          <JsonBlock label={`Kernel Request  -  call_llm @ #${call.requestSeq}`} value={kernelRequest} collapsed={1} />
        </div>
      </ScrollArea>
    )
  }
  const body = call.trace.request.body
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-2 pb-1" data-testid="provider-payload-view">
        <KeyValueTable
          rows={[
            ['url', call.trace.request.url],
            ['provider', providerFromTrace(call.trace)],
            ['body.system', providerBodyHasKey(body, 'system') ? 'present' : 'not present'],
            ['body.messages', providerArrayLength(body, 'messages')],
            ['body.tools', providerArrayLength(body, 'tools')],
          ]}
        />
        <AssemblyStep
          index="A"
          title="Provider Body Sections"
          source="provider adapter output"
          result="system/messages/tools are shown in provider-native shape below; raw kernel request remains available for comparison."
        />
        <JsonBlock label="Provider Request" value={call.trace.request} collapsed={2} />
        <JsonBlock label="Provider Request Body" value={call.trace.request.body} collapsed={1} />
        <JsonBlock label={`Kernel Request  -  call_llm @ #${call.requestSeq}`} value={kernelRequest} collapsed={2} />
      </div>
    </ScrollArea>
  )
}

function LlmResponseView({ call, parsedResponse }: { call: LlmCall; parsedResponse: unknown }): JSX.Element {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-2 pb-1" data-testid="llm-response-view">
        {call.trace ? (
          <JsonBlock label="Provider Response" value={call.trace.response ?? null} collapsed={2} />
        ) : (
          <div className="rounded bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            This log has kernel-level LLM I/O only. Provider HTTP request/response trace is available for new calls recorded after trace capture was added.
          </div>
        )}
        <JsonBlock label="Parsed Kernel Response" value={parsedResponse} collapsed={2} />
      </div>
    </ScrollArea>
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
            ['result', call.resultSeq ? `#${call.resultSeq}  -  ${toolResultLabel(call)}` : 'pending'],
          ]}
        />
        <JsonBlock label={`Tool Input  -  ${call.name}`} value={call.input} collapsed={2} />
        {call.result ? <JsonBlock label="Tool Result Event" value={call.result} collapsed={2} /> : null}
      </div>
    </ScrollArea>
  )
}

function CompactDetail({ entry, timeline }: { entry: TimelineEntry; timeline: readonly TimelineEntry[] }): JSX.Element {
  if (entry.event.kind !== 'compact_replaced') return <EmptyBlock label="Not a compaction event." />
  const compactRequest = entry.event.request ?? compactRequestFromTimeline(timeline, entry.seq)
  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 pb-1" data-testid="timeline-row-details">
        <KeyValueTable
          rows={[
            ['trigger', entry.event.trigger ?? 'unknown'],
            ['replaced messages', String(entry.event.replacedCount)],
            ['tokens', `${entry.event.tokensBefore}  -  ${entry.event.tokensAfter}`],
          ]}
        />
        <JsonBlock label="Compaction Request" value={compactRequest} collapsed={2} />
        <JsonBlock label="Compaction Result" value={entry.event} collapsed={2} />
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

function Segmented<T extends string>({ value, onChange, options, testId }: { value: T; onChange(value: T): void; options: readonly (readonly [T, string])[]; testId: string }): JSX.Element {
  return (
    <div className="inline-flex rounded bg-sidebar p-0.5" data-testid={testId}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn('rounded px-2 py-0.5 text-[11px] transition-colors', value === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground')}
          data-testid={`${testId}-${v}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function MiniAction({ children, onClick, title, ariaLabel }: { children: React.ReactNode; onClick(): void; title: string; ariaLabel?: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      aria-label={ariaLabel}
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
    <div className={cn('overflow-hidden text-xs', compact ? '' : 'rounded bg-background/70 ring-1 ring-border/30')}>
      {rows.map(([k, v]) => (
        <div key={k} className={cn('grid gap-2 px-2 odd:bg-muted/50', compact ? 'grid-cols-[6.5rem_minmax(0,1fr)] py-1' : 'grid-cols-[8rem_minmax(0,1fr)] py-1.5')}>
          <div className="truncate text-muted-foreground">{k}</div>
          <div className="min-w-0 truncate font-mono text-foreground" title={v}>{v}</div>
        </div>
      ))}
    </div>
  )
}

function buildLlmCalls(timeline: readonly TimelineEntry[]): readonly LlmCall[] {
  const calls: LlmCall[] = []
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i]!
    for (const effect of entry.effects) {
      if (effect.kind !== 'call_llm') continue
      const call: LlmCall = {
        id: `llm-${entry.seq}-${calls.length}`,
        requestSeq: entry.seq,
        effect,
      }
      for (let j = i + 1; j < timeline.length; j++) {
        const candidate = timeline[j]!
        if (candidate.event.kind === 'llm_response') {
          call.responseSeq = candidate.seq
          call.response = candidate.event
          if (candidate.llmTrace) call.trace = candidate.llmTrace
          if (candidate.model) call.model = candidate.model
          break
        }
        if (candidate.event.kind === 'llm_error') {
          call.responseSeq = candidate.seq
          call.error = candidate.event
          if (candidate.llmTrace) call.trace = candidate.llmTrace
          if (candidate.model) call.model = candidate.model
          break
        }
      }
      calls.push(call)
    }
  }
  return calls
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
      return { source: 'user', tone: 'text-amber-600 dark:text-amber-300' }
    case 'compact_replaced':
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

function eventSummary(event: AgentEvent, priorCallLlm: PriorCallLlm | null): string {
  switch (event.kind) {
    case 'user_message':
      return event.text ?? summarizeContent(event.content ?? [])
    case 'llm_response':
      return `${summarizeContent(event.message.content)}${priorCallLlm ? `  -  response to call_llm #${priorCallLlm.seq}` : ''}`
    case 'tool_result':
      return `${event.ok ? 'ok' : 'error'}  -  ${event.content.slice(0, 100)}`
    case 'user_approve':
      return `approved ${event.callId}`
    case 'user_reject':
      return `rejected ${event.callId}${event.reason ? `  -  ${event.reason}` : ''}`
    case 'llm_error':
      return event.error
    case 'compact_replaced':
      return `${event.trigger ?? 'unknown'} compact  -  ${event.replacedCount} messages  -  ${event.tokensBefore}  -  ${event.tokensAfter}`
    case 'approval_mode_changed':
      return `approval mode ${event.mode}`
    case 'cwd_changed':
      return event.cwd
    case 'cancel':
      return 'cancel requested'
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
  }).join('  -  ')
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

function contextProportions(call: LlmCall): readonly ContextProportion[] {
  const systemBytes = serializedSize(systemContextFromCall(call))
  const messageBytes = serializedSize(call.effect.messages)
  const toolBytes = serializedSize(call.effect.tools)
  const total = Math.max(1, systemBytes + messageBytes + toolBytes)
  return [
    {
      kind: 'system',
      label: 'system',
      bytes: systemBytes,
      percent: Math.round((systemBytes / total) * 100),
      color: 'bg-amber-500',
    },
    {
      kind: 'messages',
      label: 'messages',
      bytes: messageBytes,
      percent: Math.round((messageBytes / total) * 100),
      color: 'bg-sky-500',
    },
    {
      kind: 'tools',
      label: 'tools',
      bytes: toolBytes,
      percent: Math.round((toolBytes / total) * 100),
      color: 'bg-emerald-500',
    },
  ]
}

function systemContextFromCall(call: LlmCall): unknown {
  if (call.trace && providerBodyHasKey(call.trace.request.body, 'system')) {
    return (call.trace.request.body as Record<string, unknown>).system
  }
  return call.effect.messages.filter((message) => message.role === 'system')
}

function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
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
  return 'provider trace captured; exact adapter transform is shown in Provider Payload'
}

function providerBodyHasKey(body: unknown, key: string): boolean {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) && key in body)
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

function toolResultLabel(call: ToolCallLifecycle): string {
  if (!call.result) return call.rejectedSeq ? 'rejected' : 'pending'
  return `${call.result.ok ? 'ok' : 'error'}  -  ${call.result.content.length} bytes`
}

function toolLifecycleSummary(call: ToolCallLifecycle): string {
  const parts: string[] = []
  if (call.requestedSeq) parts.push(`requested #${call.requestedSeq}`)
  if (call.approvedSeq) parts.push(`approved #${call.approvedSeq}`)
  if (call.rejectedSeq) parts.push(`rejected #${call.rejectedSeq}`)
  if (call.resultSeq) parts.push(`result #${call.resultSeq}`)
  return parts.join('  -  ') || 'lifecycle not recorded'
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

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.length > 0 ? v.join(', ') : 'none'
  if (v === null || v === undefined) return 'none'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function modelFromTimeline(timeline: readonly TimelineEntry[]): string | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const trace = timeline[i]?.llmTrace
    if (trace) return `${providerFromTrace(trace)}/${modelFromTrace(trace) ?? 'model unknown'}`
  }
  return null
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

function compactRequestFromTimeline(timeline: readonly TimelineEntry[], compactSeq: number): {
  metadataSource: 'reconstructed_from_timeline'
  note: string
  unavailable: readonly string[]
  messages: readonly Message[]
  tools: readonly []
} {
  const messages: Message[] = []
  for (const row of timeline) {
    if (row.seq >= compactSeq) break
    const event = row.event
    if (event.kind === 'user_message') {
      messages.push({
        role: 'user',
        content: event.content ? [...event.content] : [{ type: 'text', text: event.text ?? '' }],
      })
    } else if (event.kind === 'llm_response') {
      messages.push(event.message)
    } else if (event.kind === 'tool_result') {
      messages.push({
        role: 'tool',
        content: [{ type: 'tool_result', callId: event.callId, ok: event.ok, content: event.content }],
      })
    }
  }
  return {
    metadataSource: 'reconstructed_from_timeline',
    note: 'This compact_replaced event predates request metadata. The dashboard reconstructed the visible transcript before compaction; exact summarizer prompt, model, and tool schema were not recorded in the log.',
    unavailable: ['model', 'systemPrompt', 'tool schemas', 'provider request options'],
    messages,
    tools: [],
  }
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
