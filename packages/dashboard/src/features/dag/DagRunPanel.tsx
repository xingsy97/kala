import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Circle,
  FileText,
  GitBranch,
  LoaderCircle,
  Network,
  PauseCircle,
} from 'lucide-react'
import type { DagDecision, DagNode, DagRun, ServerDagRunEvent } from '@agent-kernel/shared'

import type { DashboardSocket } from '../../session.js'
import { emitRpc } from '../../socket-rpc.js'
import { Button } from '../../components/ui/button.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import { randomId } from '../../lib/random-id.js'
import { AssistantMarkdown } from '../chat/ChatPanel.js'

type Props = {
  socket: DashboardSocket | null
  sessionId: string
  onOpenSession(sessionId: string): void
}

const NODE_WIDTH = 224
const NODE_HEIGHT = 88
const COLUMN_GAP = 72
const ROW_GAP = 28
const CANVAS_PADDING = 28

export function DagRunPanel({ socket, sessionId, onOpenSession }: Props): JSX.Element {
  const [runs, setRuns] = useState<readonly DagRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [view, setView] = useState<'result' | 'graph' | 'activity'>('graph')
  const [error, setError] = useState<string | null>(null)
  const [decisionAnswers, setDecisionAnswers] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!socket) return
    let active = true
    const onRun = (event: ServerDagRunEvent): void => {
      if (event.sessionId !== sessionId || !active || !event.run) return
      setRuns((current) => upsertRun(current, event.run!))
      setSelectedRunId((current) => current ?? event.run!.id)
    }
    socket.on('server:dag_run', onRun)
    void Promise.allSettled([
      emitRpc<readonly DagRun[]>(socket, 'client:list_dag_runs', { sessionId }),
      emitRpc<DagRun | null>(socket, 'client:get_dag_run', { sessionId }),
    ]).then(([historyResult, latestResult]) => {
      if (!active) return
      const history = historyResult.status === 'fulfilled' ? historyResult.value : []
      const latest = latestResult.status === 'fulfilled' ? latestResult.value : null
      const next = latest ? upsertRun(history, latest) : history
      setRuns(next)
      setSelectedRunId(latest?.id ?? next.at(-1)?.id ?? null)
      if (historyResult.status === 'rejected' && latestResult.status === 'rejected') {
        setError(latestResult.reason instanceof Error ? latestResult.reason.message : String(latestResult.reason))
      }
    })
    return () => {
      active = false
      socket.off('server:dag_run', onRun)
    }
  }, [sessionId, socket])

  const run = runs.find((candidate) => candidate.id === selectedRunId) ?? runs.at(-1) ?? null
  const layout = useMemo(() => graphLayout(run), [run])
  const selectedNode = run?.nodes.find((node) => node.id === selectedNodeId)
    ?? run?.nodes.find((node) => node.status === 'running' || node.status === 'waiting_user')
    ?? null
  const selectedAttempts = run?.attempts?.filter((attempt) => attempt.nodeId === selectedNode?.id) ?? []
  const pendingDecisions = run?.decisions.filter((decision) => decision.status === 'pending') ?? []
  const toolActivity = run?.nodes.flatMap((node) => node.toolActivity) ?? []

  useEffect(() => {
    if (!run) return
    setView(run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' ? 'result' : 'graph')
  }, [run?.id, run?.status])

  useEffect(() => {
    if (!run || (selectedNodeId && run.nodes.some((node) => node.id === selectedNodeId))) return
    setSelectedNodeId(run.nodes.find((node) => node.status === 'running' || node.status === 'waiting_user')?.id ?? null)
  }, [run, selectedNodeId])

  const answerDecision = (decision: DagDecision, answer: string): void => {
    if (!socket || !run || !answer.trim()) return
    setError(null)
    void emitRpc<DagRun>(socket, 'client:answer_dag_decision', {
      operationId: randomId(),
      sessionId,
      runId: run.id,
      decisionId: decision.id,
      answer: answer.trim(),
    }).then((updated) => {
      setRuns((current) => upsertRun(current, updated))
      setDecisionAnswers((current) => ({ ...current, [decision.id]: '' }))
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col bg-background"
      data-testid="dag-run-panel"
    >
      <div className="flex min-h-12 flex-none flex-wrap items-center gap-2 bg-card/35 px-4 py-2">
        <GitBranch className="h-4 w-4 flex-none text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">DAG-First</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground" data-testid="dag-run-status">
          {run ? `${run.status} · v${run.graphVersion}` : 'waiting for plan'}
        </span>
        {run ? (
          <nav className="order-3 flex w-full items-center gap-1 sm:order-none sm:ml-3 sm:w-auto" aria-label="DAG workspace views">
            <WorkspaceTab active={view === 'result'} disabled={!run.result && !run.error} icon={<FileText />} label="Result" onClick={() => setView('result')} />
            <WorkspaceTab active={view === 'graph'} icon={<Network />} label="Graph" onClick={() => setView('graph')} />
            <WorkspaceTab active={view === 'activity'} icon={<Activity />} label="Activity" onClick={() => setView('activity')} />
          </nav>
        ) : null}
        {runs.length > 1 ? (
          <select
            className="ml-auto max-w-72 rounded-md border-[1px] border-border/60 bg-background px-2 py-1 text-xs"
            value={run?.id ?? ''}
            onChange={(event) => {
              setSelectedRunId(event.target.value)
              setSelectedNodeId(null)
            }}
            aria-label="DAG run history"
            data-testid="dag-run-history"
          >
            {runs.map((candidate, index) => (
              <option key={candidate.id} value={candidate.id}>
                {index + 1}. {candidate.status} — {candidate.objective}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {!run ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="flex max-w-xl flex-col items-center text-center">
            <GitBranch className="mb-3 h-8 w-8 text-primary/75" aria-hidden="true" />
            <p className="text-base font-semibold">Ready for an objective</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Describe the outcome below. Kala will plan the graph, execute isolated worker Sessions, and return the final result here.
            </p>
          </div>
        </div>
      ) : pendingDecisions.length > 0 ? (
        <ScrollArea className="min-h-0 flex-1" data-testid="dag-decision-workspace">
          <div className="mx-auto max-w-2xl p-6">
            <p className="text-caption font-semibold uppercase tracking-wide text-amber-600">Decision required</p>
            <h2 className="mt-2 text-xl font-semibold">{pendingDecisions[0]!.question}</h2>
            {pendingDecisions[0]!.context ? <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{pendingDecisions[0]!.context}</p> : null}
            {pendingDecisions[0]!.reason ? <p className="mt-3 rounded-md bg-amber-500/10 p-3 text-sm">Why this is needed: {pendingDecisions[0]!.reason}</p> : null}
            <div className="mt-5 flex flex-wrap gap-2">
              {pendingDecisions[0]!.choices.map((choice) => (
                <Button key={choice} type="button" variant="outline" onClick={() => answerDecision(pendingDecisions[0]!, choice)}>{choice}</Button>
              ))}
            </div>
            {pendingDecisions[0]!.allowFreeform ? (
              <div className="mt-3 flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-md border-[1px] border-border/60 bg-background px-3 py-2 text-sm"
                  value={decisionAnswers[pendingDecisions[0]!.id] ?? ''}
                  onChange={(event) => setDecisionAnswers((current) => ({ ...current, [pendingDecisions[0]!.id]: event.target.value }))}
                  placeholder="Enter another answer"
                  aria-label={`Answer ${pendingDecisions[0]!.question}`}
                />
                <Button type="button" onClick={() => answerDecision(pendingDecisions[0]!, decisionAnswers[pendingDecisions[0]!.id] ?? '')}>Continue</Button>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      ) : view === 'result' ? (
        <ScrollArea className="min-h-0 flex-1" data-testid="dag-result-view">
          <article className="mx-auto max-w-4xl px-6 py-8">
            <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">Objective</p>
            <h1 className="mt-2 text-xl font-semibold leading-snug">{run.objective}</h1>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{run.nodes.filter((node) => node.status === 'succeeded').length}/{run.nodes.filter((node) => node.status !== 'replaced').length} nodes completed</span>
              <span aria-hidden="true">·</span>
              <span>{run.attempts?.length ?? 0} worker attempts</span>
              <span aria-hidden="true">·</span>
              <span>{toolActivity.length} tool calls</span>
              <span aria-hidden="true">·</span>
              <span>{toolActivity.filter((tool) => tool.category === 'shell').length} shell</span>
              <span aria-hidden="true">·</span>
              <span>{toolActivity.filter((tool) => tool.category === 'write').length} writes</span>
              <span aria-hidden="true">·</span>
              <span>{toolActivity.filter((tool) => tool.category === 'install').length} installs</span>
              {run.completedAt ? <><span aria-hidden="true">·</span><span>{formatTimestamp(run.completedAt)}</span></> : null}
            </div>
            {run.result ? (
              <div className="mt-7 pt-6 text-sm leading-relaxed" data-testid="dag-final-result">
                <AssistantMarkdown text={run.result} />
              </div>
            ) : (
              <div className="mt-7 rounded-lg bg-destructive/10 p-4 text-sm text-destructive" data-testid="dag-final-error">
                {run.error ?? 'This Run ended without a final result.'}
              </div>
            )}
          </article>
        </ScrollArea>
      ) : view === 'activity' ? (
        <ScrollArea className="min-h-0 flex-1" data-testid="dag-activity-view">
          <div className="mx-auto max-w-4xl px-6 py-5">
            <h2 className="text-base font-semibold">Execution activity</h2>
            <p className="mt-1 text-xs text-muted-foreground">{run.nodes.filter((node) => node.childSessionId).length} worker Sessions · {run.attempts?.length ?? 0} attempts · {run.events.length} durable events</p>
            <div className="mt-5 space-y-3">
              {[...run.nodes].filter((node) => node.status !== 'replaced').map((node) => (
                <div key={node.id} className="rounded-lg border-[1px] border-border/60 bg-muted/15 p-3">
                  <div className="flex items-center gap-2">
                    <NodeStatusIcon status={node.status} />
                    <p className="min-w-0 flex-1 text-sm font-semibold">{node.title}</p>
                    <span className="text-caption text-muted-foreground">attempt {node.attempt}</span>
                    {node.childSessionId ? <Button type="button" size="sm" variant="ghost" onClick={() => onOpenSession(node.childSessionId!)}>Open worker</Button> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{node.progress ?? node.status}</p>
                  {node.toolActivity.length ? (
                    <div className="mt-3 space-y-1 pt-2">
                      {node.toolActivity.map((tool) => (
                        <div key={tool.callId} className="flex min-w-0 items-start gap-2 text-caption">
                          <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{tool.category}</span>
                          <span className={cn('min-w-0 flex-1 break-words font-mono text-muted-foreground', tool.status === 'failed' && 'text-destructive')}>
                            {tool.name}: {tool.summary}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {run.events.length ? (
              <div className="mt-6 rounded-lg bg-muted/15 p-4">
                {run.events.slice().reverse().map((event) => (
                  <div key={event.id} className="flex gap-3 py-1.5 text-xs">
                    <span className="w-24 flex-none text-muted-foreground">{formatTimestamp(event.createdAt)}</span>
                    <span>{event.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_19rem]" data-testid="dag-run-canvas">
          <ScrollArea className="min-h-0">
            {error ? <p className="m-3 rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</p> : null}
            <div className="relative" style={{ width: layout.width, height: layout.height }} data-testid="dag-graph">
                <svg className="absolute inset-0 overflow-visible" width={layout.width} height={layout.height} aria-label="DAG dependencies">
                  <defs>
                    <marker id="dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground/60" />
                    </marker>
                  </defs>
                  {run.edges.map((edge) => {
                    const source = layout.positions.get(edge.source)
                    const target = layout.positions.get(edge.target)
                    if (!source || !target) return null
                    const x1 = source.x + NODE_WIDTH
                    const y1 = source.y + NODE_HEIGHT / 2
                    const x2 = target.x
                    const y2 = target.y + NODE_HEIGHT / 2
                    const bend = Math.max(28, (x2 - x1) / 2)
                    return (
                      <path
                        key={edge.id}
                        d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        className="stroke-muted-foreground/45"
                        strokeWidth="1.5"
                        markerEnd="url(#dag-arrow)"
                        data-testid={`dag-edge-${edge.source}-${edge.target}`}
                      />
                    )
                  })}
                </svg>
                {run.nodes.map((node) => {
                  const position = layout.positions.get(node.id)
                  if (!position) return null
                  return (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => setSelectedNodeId(node.id)}
                      className={cn(
                        'absolute flex flex-col rounded-lg border-[1px] border-border/60 bg-background px-3 py-2 text-left shadow-sm transition-colors',
                        'hover:border-primary/60 hover:bg-accent/30',
                        selectedNode?.id === node.id && 'border-primary ring-1 ring-primary/30',
                        node.status === 'failed' && 'border-destructive/60',
                        node.status === 'waiting_user' && 'border-amber-400/70',
                        node.status === 'replaced' && 'opacity-45',
                      )}
                      style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                      data-testid={`dag-node-${node.id}`}
                    >
                      <span className="flex w-full items-center gap-1.5 text-xs font-semibold">
                        <NodeStatusIcon status={node.status} />
                        <span className="min-w-0 flex-1 truncate">{node.title}</span>
                        <span className="text-caption font-normal text-muted-foreground">#{node.attempt}</span>
                      </span>
                      <span className="mt-1 line-clamp-2 text-caption leading-relaxed text-muted-foreground">
                        {node.progress ?? node.status}
                      </span>
                    </button>
                  )
                })}
            </div>
          </ScrollArea>
          <aside className="max-h-72 min-h-0 bg-card/30 lg:max-h-none" data-testid="dag-inspector">
            <ScrollArea className="h-full">
              <div className="p-3">
                {run ? (
                  <>
                    <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">Objective</p>
                    <p className="mt-1 text-xs leading-relaxed">{run.objective}</p>
                  </>
                ) : null}
                {selectedNode ? (
                  <div className="mt-3 rounded-md bg-muted/20 p-3">
                    <div className="flex items-center gap-1.5">
                      <NodeStatusIcon status={selectedNode.status} />
                      <p className="text-sm font-semibold">{selectedNode.title}</p>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{selectedNode.instructions}</p>
                    {selectedNode.result ? <Detail label="Result" value={selectedNode.result} /> : null}
                    {selectedNode.error ? <Detail label="Error" value={selectedNode.error} destructive /> : null}
                    {selectedNode.writeScopes.length ? <Detail label="Write scopes" value={selectedNode.writeScopes.join(', ')} /> : null}
                    {selectedAttempts.length ? (
                      <div className="mt-3">
                        <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">Attempts</p>
                        {selectedAttempts.map((attempt) => (
                          <p key={attempt.id} className="mt-1 text-caption text-muted-foreground">
                            #{attempt.attempt} · {attempt.status} · {formatTimestamp(attempt.startedAt)}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    {selectedNode.childSessionId ? (
                      <Button className="mt-3" type="button" size="sm" variant="outline" onClick={() => onOpenSession(selectedNode.childSessionId!)}>
                        Open worker Session
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {run?.events.length ? (
                  <div className="mt-3 rounded-md bg-muted/20 p-3">
                    <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">Activity</p>
                    <div className="mt-1 space-y-1.5">
                      {run.events.slice(-12).reverse().map((event) => (
                        <div key={event.id} className="text-caption">
                          <span className="text-muted-foreground">{formatTimestamp(event.createdAt)}</span>
                          <span className="ml-1.5">{event.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {(run?.graphHistory?.length ?? 0) > 1 ? (
                  <p className="mt-3 text-caption text-muted-foreground">
                    {run!.graphHistory!.length} durable graph versions retained
                  </p>
                ) : null}
              </div>
            </ScrollArea>
          </aside>
        </div>
      )}
    </section>
  )
}

function WorkspaceTab({
  active,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  active: boolean
  disabled?: boolean
  icon: JSX.Element
  label: string
  onClick(): void
}): JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'outline' : 'ghost'}
      disabled={disabled}
      className="h-8 gap-1.5"
      onClick={onClick}
    >
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      {label}
    </Button>
  )
}

function graphLayout(run: DagRun | null): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const positions = new Map<string, { x: number; y: number }>()
  if (!run) return { positions, width: 0, height: 0 }
  const layers = new Map<number, DagNode[]>()
  for (const node of run.nodes) {
    const layer = layers.get(node.depth) ?? []
    layer.push(node)
    layers.set(node.depth, layer)
  }
  const sorted = [...layers.entries()].sort(([left], [right]) => left - right)
  const maxRows = Math.max(1, ...sorted.map(([, nodes]) => nodes.length))
  for (const [column, [, nodes]] of sorted.entries()) {
    nodes.forEach((node, row) => {
      const columnHeight = nodes.length * NODE_HEIGHT + Math.max(0, nodes.length - 1) * ROW_GAP
      const totalHeight = maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP
      positions.set(node.id, {
        x: CANVAS_PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: CANVAS_PADDING + (totalHeight - columnHeight) / 2 + row * (NODE_HEIGHT + ROW_GAP),
      })
    })
  }
  return {
    positions,
    width: Math.max(1, sorted.length) * NODE_WIDTH + Math.max(0, sorted.length - 1) * COLUMN_GAP + CANVAS_PADDING * 2,
    height: maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP + CANVAS_PADDING * 2,
  }
}

function upsertRun(runs: readonly DagRun[], run: DagRun): readonly DagRun[] {
  const next = runs.filter((candidate) => candidate.id !== run.id)
  next.push(run)
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function Detail({ label, value, destructive = false }: { label: string; value: string; destructive?: boolean }): JSX.Element {
  return (
    <div className="mt-3">
      <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1 max-h-32 whitespace-pre-wrap text-xs leading-relaxed [overflow:auto]', destructive && 'text-destructive')}>{value}</p>
    </div>
  )
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function NodeStatusIcon({ status }: { status: DagNode['status'] }): JSX.Element {
  if (status === 'succeeded') return <CheckCircle2 className="h-3.5 w-3.5 flex-none text-emerald-500" />
  if (status === 'failed' || status === 'cancelled') return <AlertCircle className="h-3.5 w-3.5 flex-none text-destructive" />
  if (status === 'waiting_user') return <PauseCircle className="h-3.5 w-3.5 flex-none text-amber-500" />
  if (status === 'running') return <LoaderCircle className="h-3.5 w-3.5 flex-none animate-spin text-primary" />
  return <Circle className="h-3.5 w-3.5 flex-none text-muted-foreground" />
}
