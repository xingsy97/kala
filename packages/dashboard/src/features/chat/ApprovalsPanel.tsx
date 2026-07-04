import type { ApprovalRequiredEvent } from '@agent-kernel/shared'

type Props = {
  approvals: readonly ApprovalRequiredEvent[]
  onDecision(callId: string, decision: 'approve' | 'reject'): void
}

export function ApprovalsPanel({ approvals, onDecision }: Props): JSX.Element {
  if (approvals.length === 0) {
    return (
      <div className="p-3 text-slate-500 text-sm border-t border-slate-800">
        No pending approvals.
      </div>
    )
  }
  return (
    <div className="border-t border-slate-800 p-3 flex flex-col gap-2">
      {approvals.map((a) => (
        <div
          key={a.callId}
          className="rounded border border-amber-700/50 bg-amber-950/40 p-3"
        >
          <div className="text-xs uppercase tracking-wide text-amber-300 mb-1">
            approval required
          </div>
          <div className="text-sm text-slate-100 font-mono">
            {a.name}{' '}
            <span className="text-slate-500">({a.callId})</span>
          </div>
          <pre className="mt-1 text-xs whitespace-pre-wrap text-amber-100/80 font-mono">
            {JSON.stringify(a.input, null, 2)}
          </pre>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => onDecision(a.callId, 'approve')}
              className="px-2 py-1 text-xs rounded bg-emerald-700 hover:bg-emerald-600 text-white"
            >
              approve
            </button>
            <button
              onClick={() => onDecision(a.callId, 'reject')}
              className="px-2 py-1 text-xs rounded bg-rose-700 hover:bg-rose-600 text-white"
            >
              reject
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
