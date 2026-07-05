import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react'

import type { ApprovalRequiredEvent } from '@agent-kernel/shared'

import { JsonBlock } from '../../components/ui/json-block.js'
import { Button } from '../../components/ui/button.js'
import { DiffPreview } from './DiffPreview.js'

type Props = {
  approvals: readonly ApprovalRequiredEvent[]
  onDecision(callId: string, decision: 'approve' | 'reject'): void
}

export function ApprovalsPanel({ approvals, onDecision }: Props): JSX.Element | null {
  if (approvals.length === 0) return null
  return (
    <div
      className="border-t border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20"
      data-testid="approvals-panel"
    >
      {approvals.map((a) => (
        <ApprovalRow key={a.callId} approval={a} onDecision={onDecision} />
      ))}
    </div>
  )
}

function ApprovalRow({
  approval,
  onDecision,
}: {
  approval: ApprovalRequiredEvent
  onDecision(callId: string, decision: 'approve' | 'reject'): void
}): JSX.Element {
  const hasDiffPreview = approval.name === 'edit' || approval.name === 'write'
  const [expanded, setExpanded] = useState(hasDiffPreview)
  const preview = formatArgsPreview(approval.input)
  return (
    <div className="px-3 py-1.5 flex flex-wrap items-center gap-2 text-xs border-b border-amber-200/60 last:border-b-0 dark:border-amber-900/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex-none text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100"
        aria-label={expanded ? 'collapse arguments' : 'expand arguments'}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      <span className="font-mono text-slate-800 dark:text-slate-100 flex-none">
        {approval.name}
      </span>
      <span
        className="font-mono text-slate-500 dark:text-slate-500 truncate flex-1 min-w-0"
        title={preview}
      >
        {preview}
      </span>
      <Button
        size="sm"
        onClick={() => onDecision(approval.callId, 'approve')}
        data-testid="approval-approve"
        className="h-6 px-2 flex-none bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
      >
        <Check className="h-3.5 w-3.5 mr-1" />
        approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onDecision(approval.callId, 'reject')}
        data-testid="approval-reject"
        className="h-6 px-2 flex-none"
      >
        <X className="h-3.5 w-3.5 mr-1" />
        reject
      </Button>
      {expanded ? (
        hasDiffPreview ? (
          <DiffPreview toolName={approval.name} input={approval.input} />
        ) : (
          <div className="basis-full mt-1.5">
            <JsonBlock value={approval.input} label={approval.name} collapsed={2} />
          </div>
        )
      ) : null}
    </div>
  )
}

function formatArgsPreview(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return '{}'
  return entries
    .map(([k, v]) => `${k}=${shortValue(v)}`)
    .join(' ')
}

function shortValue(v: unknown): string {
  if (typeof v === 'string') {
    return v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`
  }
  if (v === null || typeof v !== 'object') return String(v)
  try {
    const s = JSON.stringify(v)
    return s.length > 40 ? `${s.slice(0, 40)}…` : s
  } catch {
    return '[object]'
  }
}
