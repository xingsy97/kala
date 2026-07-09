import type { AgentState } from '@agent-kernel/kernel'
import type { TimelineEntry } from '../../session.js'

type Props = {
  state: AgentState | null
  timeline: readonly TimelineEntry[]
  onFork?(cursor: number): void
}

export function InspectorPanel({
  state,
  timeline,
  onFork,
}: Props): JSX.Element {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StateHeader state={state} />
      <Timeline timeline={timeline} onFork={onFork} />
      <StateTree state={state} />
    </div>
  )
}

function StateHeader({ state }: { state: AgentState | null }): JSX.Element {
  if (!state) {
    return (
      <div className="p-3 border-b border-slate-800 text-sm text-slate-500">
        connecting…
      </div>
    )
  }
  return (
    <div className="p-3 border-b border-slate-800 grid grid-cols-2 gap-2 text-xs">
      <Metric label="status" value={state.status} />
      <Metric label="cursor" value={String(state.cursor)} />
      <Metric label="pending" value={String(state.pendingCalls.length)} />
      <Metric
        label="tokens"
        value={`${state.usage.inputTokens} in / ${state.usage.outputTokens} out`}
      />
    </div>
  )
}

function Metric({
  label,
  value,
}: {
  label: string
  value: string
}): JSX.Element {
  return (
    <div>
      <div className="text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-slate-100 font-mono">{value}</div>
    </div>
  )
}

function Timeline({
  timeline,
  onFork,
}: {
  timeline: readonly TimelineEntry[]
  onFork?(cursor: number): void
}): JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto border-b border-slate-800">
      <div className="p-3 text-xs uppercase tracking-wide text-slate-500">
        timeline
      </div>
      {timeline.length === 0 ? (
        <div className="px-3 pb-3 text-sm text-slate-500">no events yet</div>
      ) : (
        <ul className="px-3 pb-3 space-y-1">
          {timeline.map((t) => (
            <li
              key={t.seq}
              className="text-xs font-mono flex items-center justify-between gap-2 py-1"
            >
              <span className="text-slate-500 w-6 text-right">{t.seq}</span>
              <span className="flex-1 text-slate-200">{t.event.kind}</span>
              <span className="text-slate-500">
                {t.effects.map((e) => e.kind).join(', ') || '—'}
              </span>
              {onFork ? (
                <button
                  onClick={() => onFork(t.seq)}
                  title={`fork at cursor ${t.seq}`}
                  className="text-slate-400 hover:text-slate-100"
                >
                  ⑂
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StateTree({ state }: { state: AgentState | null }): JSX.Element {
  return (
    <details className="border-t border-slate-800">
      <summary className="cursor-pointer p-3 text-xs uppercase tracking-wide text-slate-500">
        raw state
      </summary>
      <pre className="p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap max-h-64 overflow-y-auto">
        {state ? JSON.stringify(state, null, 2) : '—'}
      </pre>
    </details>
  )
}
