/**
 * ApprovalCard  -  the "approval face" of the composer/approval flip container.
 *
 * When one or more tool calls await user approval, the composer flips to this
 * card. It shows one approval at a time (1 of N) with prev/next navigation, a
 * details expansion (diff for edit/write, JSON otherwise), and top-right
 * batch "Approve all / Reject all" affordances. Keyboard: Enter approves,
 * Escape rejects,  - / -  navigate.
 *
 * Data flows in from `pendingApprovals`; user decisions call `onDecision` per
 * callId. The parent (app.tsx) is the source of truth for the pending list;
 * this component keeps only a local carousel index.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  TriangleAlert,
  X,
} from 'lucide-react'

import type { ApprovalRequiredEvent } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { JsonBlock } from '../../components/ui/json-block.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import { DiffPreview } from './DiffPreview.js'
import { pickPrimaryArg } from './InlineStatusRow.js'

type Props = {
  approvals: readonly ApprovalRequiredEvent[]
  onDecision(callId: string, decision: 'approve' | 'reject'): void
}

export function ApprovalCard({ approvals, onDecision }: Props): JSX.Element | null {
  const [current, setCurrent] = useState(0)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const approveBtnRef = useRef<HTMLButtonElement>(null)

  // Clamp `current` inside the current list. When the item at `current` is
  // approved/rejected the parent trims the list; keeping the index in range
  // lets the carousel naturally advance to the next pending item.
  const total = approvals.length
  useEffect(() => {
    if (total === 0) {
      setCurrent(0)
      setDetailsOpen(false)
      return
    }
    if (current >= total) setCurrent(total - 1)
  }, [total, current])

  // Auto-focus the primary action so `Enter` immediately approves. Refocus on
  // every carousel move so the shortcut keeps working after  - / - .
  useEffect(() => {
    if (total === 0) return
    approveBtnRef.current?.focus()
  }, [current, total])

  const approval = approvals[current] ?? null

  const goPrev = useCallback(() => {
    setCurrent((i) => (i - 1 + total) % Math.max(1, total))
    setDetailsOpen(false)
  }, [total])

  const goNext = useCallback(() => {
    setCurrent((i) => (i + 1) % Math.max(1, total))
    setDetailsOpen(false)
  }, [total])

  const approveCurrent = useCallback(() => {
    if (!approval) return
    onDecision(approval.callId, 'approve')
  }, [approval, onDecision])

  const rejectCurrent = useCallback(() => {
    if (!approval) return
    onDecision(approval.callId, 'reject')
  }, [approval, onDecision])

  const approveAll = useCallback(() => {
    // Snapshot so we don't race the parent's list-shrink between iterations.
    for (const a of approvals) onDecision(a.callId, 'approve')
  }, [approvals, onDecision])

  const rejectAll = useCallback(() => {
    for (const a of approvals) onDecision(a.callId, 'reject')
  }, [approvals, onDecision])

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Ignore keystrokes typed inside child inputs (should not exist today, but
    // keeps the handler safe if we later embed one).
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'Enter') {
      e.preventDefault()
      approveCurrent()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      rejectCurrent()
    } else if (e.key === 'ArrowLeft' && total > 1) {
      e.preventDefault()
      goPrev()
    } else if (e.key === 'ArrowRight' && total > 1) {
      e.preventDefault()
      goNext()
    }
  }

  if (!approval) return null

  const hasDiff = approval.name === 'edit' || approval.name === 'write'
  const primary = pickPrimaryArg(approval.name, approval.input)

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-lg border shadow-sm',
        'border-amber-300/70 bg-amber-50/80 text-amber-950',
        'dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100',
      )}
      data-testid="approval-card"
      role="dialog"
      aria-label="Tool approval required"
      onKeyDown={onKey}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-amber-200/70 px-3 py-2 dark:border-amber-500/30">
        <TriangleAlert className="h-4 w-4 flex-none text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-semibold uppercase tracking-wide">
          Approval required
        </span>
        {total > 1 ? (
          <span
            className="ml-1 rounded-full bg-amber-200/60 px-2 py-0.5 text-[10px] font-medium tabular-nums text-amber-900 dark:bg-amber-500/20 dark:text-amber-100"
            data-testid="approval-card-index"
          >
            {current + 1} of {total}
          </span>
        ) : null}
        <span className="flex-1" />
        {total > 1 ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={rejectAll}
              data-testid="approval-reject-all"
              className="h-6 px-2 text-[11px] text-amber-800 hover:bg-amber-200/60 dark:text-amber-200 dark:hover:bg-amber-500/20"
            >
              Reject all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={approveAll}
              data-testid="approval-approve-all"
              className="h-6 px-2 text-[11px] text-emerald-800 hover:bg-emerald-200/60 dark:text-emerald-200 dark:hover:bg-emerald-500/20"
            >
              Approve all
            </Button>
          </>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded bg-amber-200/70 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-900 dark:bg-amber-500/30 dark:text-amber-100">
            {approval.name}
          </span>
          {primary ? (
            <span
              className="min-w-0 flex-1 truncate font-mono text-[12px] text-amber-900/90 dark:text-amber-100/90"
              title={primary}
              data-testid="approval-card-primary"
            >
              {primary}
            </span>
          ) : (
            <span className="text-[12px] italic text-amber-800/70 dark:text-amber-200/70">
              (no arguments)
            </span>
          )}
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="flex flex-none items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-200/60 dark:text-amber-200 dark:hover:bg-amber-500/20"
            data-testid="approval-details-toggle"
            aria-expanded={detailsOpen}
          >
            {detailsOpen ? (
              <>
                <ChevronUp className="h-3 w-3" />
                Hide details
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" />
                View details
              </>
            )}
          </button>
        </div>

        {detailsOpen ? (
          <ScrollArea
            className="max-h-56 rounded-md border border-amber-200/60 bg-white/70 dark:border-amber-500/20 dark:bg-black/20"
            data-testid="approval-details"
          >
            <div className="p-2">
              {hasDiff ? (
                <DiffPreview toolName={approval.name} input={approval.input} />
              ) : (
                <JsonBlock value={approval.input} label={approval.name} collapsed={2} />
              )}
            </div>
          </ScrollArea>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {total > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={goPrev}
              data-testid="approval-prev"
              aria-label="Previous approval"
              className="h-8 flex-none px-2 text-amber-800 hover:bg-amber-200/60 dark:text-amber-200 dark:hover:bg-amber-500/20"
            >
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            onClick={rejectCurrent}
            data-testid="approval-reject"
            className="h-8 flex-none border-amber-300 px-3 text-amber-900 hover:bg-amber-200/70 dark:border-amber-500/40 dark:text-amber-100 dark:hover:bg-amber-500/20"
          >
            <X className="mr-1 h-4 w-4" />
            Reject
          </Button>
          <Button
            ref={approveBtnRef}
            size="sm"
            onClick={approveCurrent}
            data-testid="approval-approve"
            className="h-8 flex-none bg-emerald-600 px-4 text-white shadow hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500/60 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            <Check className="mr-1 h-4 w-4" />
            Approve
          </Button>
          {total > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={goNext}
              data-testid="approval-next"
              aria-label="Next approval"
              className="h-8 flex-none px-2 text-amber-800 hover:bg-amber-200/60 dark:text-amber-200 dark:hover:bg-amber-500/20"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : null}
        </div>

        <p className="text-[10px] text-amber-800/70 dark:text-amber-200/60">
          Enter  -  approve  -  Esc  -  reject{total > 1 ? '  -   -  /  -   -  switch' : ''}
        </p>
      </div>
    </div>
  )
}
