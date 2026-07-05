import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import type { AgentEvent, AgentState, CallLlmEffect, Effect } from '@agent-kernel/kernel'

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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { Button } from '../../components/ui/button.js'
import { JsonBlock } from '../../components/ui/json-block.js'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../../components/ui/resizable.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'

type Props = {
  state: AgentState | null
  timeline: readonly TimelineEntry[]
  visibleMessagesCount?: number
  onFork?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
}

export function InspectorPanel({
  state,
  timeline,
  visibleMessagesCount,
  onFork,
  onJumpToMessage,
}: Props): JSX.Element {
  const [pendingForkSeq, setPendingForkSeq] = useState<number | null>(null)
  const [historyView, setHistoryView] = useState<'timeline' | 'state-flow'>('timeline')
  const [selectedTimeline, setSelectedTimeline] = useState<{
    entry: TimelineEntry
    priorCallLlm: { seq: number; effect: CallLlmEffect } | null
  } | null>(null)
  const flow = stateFlow(timeline)

  const confirmFork = (): void => {
    if (pendingForkSeq !== null && onFork) onFork(pendingForkSeq)
    setPendingForkSeq(null)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup
          direction="vertical"
          autoSaveId="ak-inspector-split"
        >
          <ResizablePanel defaultSize={65} minSize={25}>
            <HistorySection
              view={historyView}
              onViewChange={setHistoryView}
              timeline={timeline}
              flow={flow}
              messagesCount={visibleMessagesCount ?? state?.messages.length ?? 0}
              onForkRequest={onFork ? (seq) => setPendingForkSeq(seq) : undefined}
              onJumpToMessage={onJumpToMessage}
              onInspect={setSelectedTimeline}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={35} minSize={10}>
            <RawStateSection state={state} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

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
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {pendingForkSeq ?? ''}
              </span>{' '}
              — its history up to (but not including) this row is copied. You
              can return to the parent via the &quot;go to parent&quot; link at
              the top.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmFork}
              data-testid="confirm-fork-button"
            >
              Fork
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={selectedTimeline !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedTimeline(null)
        }}
      >
        <DialogContent className="max-w-5xl h-[86vh] overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <DialogTitle className="text-base">
              Timeline event #{selectedTimeline?.entry.seq}
            </DialogTitle>
            <DialogDescription>
              {selectedTimeline?.entry.event.kind ?? ''}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0">
            <div className="p-4">
            {selectedTimeline ? (
              <EventDetails
                entry={selectedTimeline.entry}
                priorCallLlm={selectedTimeline.priorCallLlm}
              />
            ) : null}
            </div>
          </ScrollArea>
          <DialogFooter className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            <DialogClose asChild>
              <Button variant="outline" className="mt-0">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function HistorySection({
  view,
  onViewChange,
  timeline,
  flow,
  messagesCount,
  onForkRequest,
  onJumpToMessage,
  onInspect,
}: {
  view: 'timeline' | 'state-flow'
  onViewChange(view: 'timeline' | 'state-flow'): void
  timeline: readonly TimelineEntry[]
  flow: readonly StateFlowStep[]
  messagesCount: number
  onForkRequest?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
  onInspect(payload: {
    entry: TimelineEntry
    priorCallLlm: { seq: number; effect: CallLlmEffect } | null
  }): void
}): JSX.Element {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500 flex-none">
        <span className="font-medium">History</span>
        <div
          className="ml-auto inline-flex rounded border border-slate-200 bg-white p-0.5 dark:border-slate-800 dark:bg-slate-950"
          data-testid="history-view-switch"
        >
          <button
            type="button"
            onClick={() => onViewChange('timeline')}
            className={cn(
              'rounded px-2 py-0.5 text-[11px]',
              view === 'timeline'
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-950'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900',
            )}
            data-testid="history-view-timeline"
          >
            Timeline
          </button>
          <button
            type="button"
            onClick={() => onViewChange('state-flow')}
            className={cn(
              'rounded px-2 py-0.5 text-[11px]',
              view === 'state-flow'
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-950'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900',
            )}
            data-testid="history-view-state-flow"
          >
            State flow
          </button>
        </div>
      </div>
      {view === 'timeline' ? (
        <Timeline
          timeline={timeline}
          messagesCount={messagesCount}
          onForkRequest={onForkRequest}
          onJumpToMessage={onJumpToMessage}
          onInspect={onInspect}
        />
      ) : (
        <StateFlowSection steps={flow} />
      )}
    </div>
  )
}

function StateFlowSection({ steps }: { steps: readonly StateFlowStep[] }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2 text-xs text-slate-500 flex-none">
        reducer status after each event
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {steps.length === 0 ? (
          <div className="px-3 pb-3 text-sm text-slate-500">no state transitions yet</div>
        ) : (
          <ol className="px-2 pb-3 space-y-1" data-testid="state-flow-list">
            {steps.map((step) => (
              <StateFlowRow key={step.seq} step={step} />
            ))}
          </ol>
        )}
      </ScrollArea>
    </div>
  )
}

function StateFlowRow({ step }: { step: StateFlowStep }): JSX.Element {
  const changed = step.from !== step.to
  return (
    <li
      className="rounded border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-800"
      data-testid="state-flow-row"
    >
      <div className="flex items-center gap-2">
        <span className="w-8 flex-none text-right font-mono text-slate-500">#{step.seq}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-slate-700 dark:text-slate-200">
          {step.eventKind}
        </span>
        <span className={cn('font-mono', changed ? 'text-sky-700 dark:text-sky-300' : 'text-slate-500')}>
          {statusLabel(step.from)} → {statusLabel(step.to)}
        </span>
      </div>
      {step.effects.length > 0 ? (
        <div className="mt-1 truncate pl-10 font-mono text-[11px] text-slate-500">
          effects: {step.effects.map((e) => e.kind).join(', ')}
        </div>
      ) : null}
    </li>
  )
}

function statusLabel(status: StateFlowStep['from']): string {
  switch (status) {
    case 'idle':
      return 'Ready'
    case 'thinking':
      return 'Waiting for LLM'
    case 'awaiting_approval':
      return 'Needs approval'
    case 'executing_tools':
      return 'Running tools'
    case 'done':
      return 'Done'
    case 'error':
      return 'Error'
  }
}

function inboundOf(event: AgentEvent): { source: string; tone: string } {
  switch (event.kind) {
    case 'user_message':
      return { source: 'user', tone: 'text-sky-600 dark:text-sky-300' }
    case 'llm_response':
      return { source: 'llm', tone: 'text-violet-600 dark:text-violet-300' }
    case 'llm_error':
      return { source: 'llm', tone: 'text-rose-600 dark:text-rose-300' }
    case 'user_approve':
      return { source: 'user', tone: 'text-emerald-600 dark:text-emerald-300' }
    case 'user_reject':
      return { source: 'user', tone: 'text-rose-600 dark:text-rose-300' }
    case 'tool_result':
      return {
        source: 'executor',
        tone: event.ok
          ? 'text-emerald-600 dark:text-emerald-300'
          : 'text-rose-600 dark:text-rose-300',
      }
    case 'cancel':
      return { source: 'user', tone: 'text-amber-600 dark:text-amber-300' }
    case 'compact_replaced':
      return { source: 'host', tone: 'text-amber-600 dark:text-amber-300' }
    case 'approval_mode_changed':
      return { source: 'user', tone: 'text-sky-600 dark:text-sky-300' }
    case 'cwd_changed':
      return { source: 'user', tone: 'text-sky-600 dark:text-sky-300' }
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
      return { target: 'done', tone: 'text-slate-500' }
    case 'emit_error':
      return { target: 'error', tone: 'text-rose-600 dark:text-rose-300' }
  }
}

function messageIndexFor(
  timeline: readonly TimelineEntry[],
  currentIndex: number,
  messagesCount: number,
): number | null {
  const t = timeline[currentIndex]
  if (!t) return null
  const producesMessage =
    t.event.kind === 'user_message' ||
    t.event.kind === 'llm_response' ||
    t.event.kind === 'tool_result'
  if (!producesMessage) return null
  let seen = -1
  for (let i = 0; i <= currentIndex; i++) {
    const ev = timeline[i]!.event
    if (
      ev.kind === 'user_message' ||
      ev.kind === 'llm_response' ||
      ev.kind === 'tool_result'
    ) {
      seen += 1
    }
  }
  if (seen < 0 || seen >= messagesCount) return null
  return seen
}

function Timeline({
  timeline,
  messagesCount,
  onForkRequest,
  onJumpToMessage,
  onInspect,
}: {
  timeline: readonly TimelineEntry[]
  messagesCount: number
  onForkRequest?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
  onInspect(payload: {
    entry: TimelineEntry
    priorCallLlm: { seq: number; effect: CallLlmEffect } | null
  }): void
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2 text-xs text-slate-500 flex-none">
        click any row to inspect the raw event + effects JSON
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {timeline.length === 0 ? (
          <div className="px-3 pb-3 text-sm text-slate-500">no events yet</div>
        ) : (
          <ul className="px-2 pb-3 space-y-1">
            {timeline.map((t, i) => (
              <TimelineRow
                key={t.seq}
                entry={t}
                priorCallLlm={findPriorCallLlm(timeline, i)}
                messageIndex={messageIndexFor(timeline, i, messagesCount)}
                onForkRequest={onForkRequest}
                onJumpToMessage={onJumpToMessage}
                onInspect={onInspect}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

// For an `llm_response` at index i, find the seq of the most recent
// `call_llm` effect before it — that's the request this response answers.
function findPriorCallLlm(
  timeline: readonly TimelineEntry[],
  i: number,
): { seq: number; effect: CallLlmEffect } | null {
  if (timeline[i]?.event.kind !== 'llm_response') return null
  for (let j = i - 1; j >= 0; j--) {
    const entry = timeline[j]!
    const eff = entry.effects.find((e) => e.kind === 'call_llm')
    if (eff) return { seq: entry.seq, effect: eff as CallLlmEffect }
  }
  return null
}

function TimelineRow({
  entry,
  priorCallLlm,
  messageIndex,
  onForkRequest,
  onJumpToMessage,
  onInspect,
}: {
  entry: TimelineEntry
  priorCallLlm: { seq: number; effect: CallLlmEffect } | null
  messageIndex: number | null
  onForkRequest?(cursor: number): void
  onJumpToMessage?(messageIndex: number): void
  onInspect(payload: {
    entry: TimelineEntry
    priorCallLlm: { seq: number; effect: CallLlmEffect } | null
  }): void
}): JSX.Element {
  const inbound = inboundOf(entry.event)
  const jumpable = messageIndex !== null && onJumpToMessage !== undefined
  return (
    <li className="text-xs" data-testid="timeline-row">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onInspect({ entry, priorCallLlm })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onInspect({ entry, priorCallLlm })
          }
        }}
        aria-label={`inspect timeline event ${entry.seq}`}
        data-testid="timeline-row-header"
        className={cn(
          'group flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer select-none',
          'hover:bg-slate-100 dark:hover:bg-slate-800/60',
        )}
      >
        <span className="text-slate-500 w-8 text-right font-mono flex-none">
          #{entry.seq}
        </span>
        <span
          className={cn('font-mono flex-none w-16', inbound.tone)}
          title={`inbound from ${inbound.source}`}
        >
          {inbound.source}
        </span>
        <span className="text-slate-500 flex-none">→</span>
        <span
          className={cn(
            'font-mono flex-1 min-w-0 truncate text-slate-700 dark:text-slate-200',
          )}
          title={entry.event.kind}
        >
          {entry.event.kind}
        </span>
        {jumpable ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onJumpToMessage!(messageIndex!)
            }}
            title={`scroll chat to message #${messageIndex}`}
            data-testid="jump-to-message-button"
            className="inline-flex items-center gap-1 rounded border border-slate-300 dark:border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 hover:text-sky-700 hover:border-sky-400 dark:hover:text-sky-300 dark:hover:border-sky-500"
          >
            msg #{messageIndex}
          </button>
        ) : null}
        {onForkRequest ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onForkRequest(entry.seq)
            }}
            title={`fork a new session at cursor ${entry.seq}`}
            aria-label={`fork at cursor ${entry.seq}`}
            data-testid="fork-button"
            className="inline-flex items-center gap-1 rounded border border-slate-300 dark:border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 hover:text-amber-700 hover:border-amber-400 dark:hover:text-amber-300 dark:hover:border-amber-500"
          >
            <GitBranch className="h-3 w-3" />
            fork
          </button>
        ) : null}
      </div>
      {entry.effects.length > 0 ? (
        <ul className="ml-10 mt-0.5 space-y-0.5">
          {entry.effects.map((eff, ei) => {
            const target = effectTarget(eff)
            return (
              <li
                key={ei}
                className="flex items-center gap-1 text-[11px] text-slate-500 font-mono"
              >
                <span className="text-slate-500">→</span>
                <span className={target.tone}>{target.target}</span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-600 dark:text-slate-400 truncate">
                  {eff.kind}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}

function EventDetails({
  entry,
  priorCallLlm,
}: {
  entry: TimelineEntry
  priorCallLlm: { seq: number; effect: CallLlmEffect } | null
}): JSX.Element {
  // For an `llm_response`, split the "request JSON" (from the prior call_llm)
  // and the "response JSON" (this event's message) so the operator can eyeball
  // exactly what left and what came back. For everything else, show the raw
  // event + resulting effects.
  if (entry.event.kind === 'llm_response' && priorCallLlm) {
    return (
      <div
        className="grid grid-cols-1 lg:grid-cols-2 gap-2"
        data-testid="timeline-row-details"
      >
        <JsonBlock
          label={`request to LLM · call_llm @ #${priorCallLlm.seq}`}
          value={{
            messages: priorCallLlm.effect.messages,
            tools: priorCallLlm.effect.tools,
          }}
          collapsed={2}
        />
        <JsonBlock
          label={`response from LLM · llm_response @ #${entry.seq}`}
          value={{
            message: entry.event.message,
            usage: entry.event.usage,
          }}
          collapsed={2}
        />
      </div>
    )
  }
  if (entry.event.kind === 'compact_replaced') {
    return (
      <div
        className="grid grid-cols-1 lg:grid-cols-2 gap-2"
        data-testid="timeline-row-details"
      >
        <JsonBlock
          label={`compact summarizer request · #${entry.seq}`}
          value={entry.event.request ?? { missing: 'compact request metadata was not recorded' }}
          collapsed={2}
        />
        <JsonBlock
          label={`compact result · #${entry.seq}`}
          value={{
            trigger: entry.event.trigger,
            summary: entry.event.summary,
            replacedCount: entry.event.replacedCount,
            tokensBefore: entry.event.tokensBefore,
            tokensAfter: entry.event.tokensAfter,
            responseUsage: entry.event.responseUsage,
          }}
          collapsed={2}
        />
      </div>
    )
  }
  return (
    <div
      className="space-y-2"
      data-testid="timeline-row-details"
    >
      <JsonBlock
        label={`event · ${entry.event.kind}`}
        value={entry.event}
        collapsed={2}
      />
      {entry.effects.map((eff, ei) => (
        <JsonBlock
          key={ei}
          label={`effect · ${eff.kind}`}
          value={eff}
          collapsed={2}
        />
      ))}
    </div>
  )
}

function RawStateSection({ state }: { state: AgentState | null }): JSX.Element {
  return (
    <div className="h-full flex flex-col border-t border-slate-200 dark:border-slate-800">
      <div className="px-3 py-2 text-xs text-slate-500 flex-none">
        <span className="font-medium">Agent state</span>
        <span className="ml-2 normal-case tracking-normal text-slate-500 dark:text-slate-600">
          full runtime state JSON
        </span>
      </div>
      <div className="flex-1 min-h-0 mx-3 mb-3">
        {state ? (
          <JsonBlock
            label="AgentState"
            value={state}
            collapsed={2}
            className="h-full [&>div:last-child]:max-h-none [&>div:last-child]:h-[calc(100%-2rem)]"
          />
        ) : (
          <div className="text-xs text-slate-500">—</div>
        )}
      </div>
    </div>
  )
}
