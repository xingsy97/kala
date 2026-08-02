import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Circle, CircleDashed, GitBranch, LockKeyhole, X } from 'lucide-react'

import { cn } from '../../lib/utils.js'
import type { TaskGraphNode, TaskGraphSnapshot, TaskGraphStatus } from './task-graph-from-timeline.js'

type Props = { graph: TaskGraphSnapshot | null }

export function TaskGraphButton({ graph }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [graphView, setGraphView] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key) }
  }, [open])
  if (!graph || graph.nodes.length === 0) return null
  const { summary } = graph
  const done = summary.completed + summary.cancelled
  const allDone = done === summary.total
  const allBlocked = summary.blocked > 0 && summary.active === 0 && summary.ready === 0
  return <div className="relative flex-none" ref={root}>
    <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="dialog" data-testid="task-graph-trigger"
      title={`${summary.completed} completed · ${summary.active} active · ${summary.ready} ready · ${summary.blocked} blocked`}
      className={cn('inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent sm:h-7', open && 'bg-accent text-foreground', allDone && 'text-emerald-700 dark:text-emerald-300', allBlocked && 'text-amber-700 dark:text-amber-300')}>
      <GitBranch className="h-3.5 w-3.5" /><span>{done}/{summary.total}</span>
      <span className="hidden sm:inline">· {summary.ready} ready</span>
      {summary.active > 0 ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" /> : null}
    </button>
    {open ? <div role="dialog" aria-label="Task graph" data-testid="task-graph-popover" className="fixed inset-x-2 bottom-[5.5rem] z-30 flex max-h-[76dvh] flex-col overflow-hidden rounded-lg border border-border/60 bg-popover shadow-xl sm:inset-x-4 sm:bottom-20 lg:left-1/2 lg:right-auto lg:w-[min(72rem,calc(100vw-2rem))] lg:-translate-x-1/2">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <GitBranch className="h-4 w-4" /><span className="text-sm font-medium">Task Graph</span><span className="text-xs text-muted-foreground">rev {graph.revision}</span>
        <button className="ml-auto rounded px-2 py-1 text-xs hover:bg-accent" onClick={() => setGraphView((value) => !value)}>{graphView ? 'List view' : 'Graph view'}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {graphView ? <GraphView graph={graph} /> : <GroupedList graph={graph} />}
      </div>
    </div> : null}
  </div>
}

function GroupedList({ graph }: { graph: TaskGraphSnapshot }): JSX.Element {
  const blocked = new Map(graph.blocked.map((item) => [item.id, item.waitingOn]))
  const groups = [
    ['Active', graph.nodes.filter((node) => node.status === 'in_progress')],
    ['Ready', graph.nodes.filter((node) => graph.ready.includes(node.id))],
    ['Blocked', graph.nodes.filter((node) => blocked.has(node.id))],
    ['Done', graph.nodes.filter((node) => node.status === 'completed' || node.status === 'cancelled')],
  ] as const
  return <div className="space-y-3">{groups.map(([label, nodes]) => nodes.length ? <section key={label}>
    <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label} ({nodes.length})</h3>
    <div className="space-y-1">{nodes.map((node) => <NodeRow key={node.id} node={node} waitingOn={blocked.get(node.id)} />)}</div>
  </section> : null)}</div>
}

function NodeRow({ node, waitingOn }: { node: TaskGraphNode; waitingOn?: readonly string[] }): JSX.Element {
  return <div className="flex gap-2 rounded-md bg-muted/35 px-2.5 py-2 text-sm">
    <StatusIcon status={node.status} blocked={Boolean(waitingOn?.length)} />
    <div className="min-w-0"><div className={cn('break-words', (node.status === 'completed' || node.status === 'cancelled') && 'text-muted-foreground line-through')}>{node.content}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground"><code>{node.id}</code>{node.priority ? ` · ${node.priority}` : ''}{waitingOn?.length ? ` · waiting on ${waitingOn.join(', ')}` : ''}</div>
    </div>
  </div>
}

const GRAPH_NODE_WIDTH = 184
const GRAPH_NODE_HEIGHT = 76
const GRAPH_COLUMN_GAP = 104
const GRAPH_ROW_GAP = 28
const GRAPH_PADDING = 28

type PositionedNode = { node: TaskGraphNode; x: number; y: number }

function GraphView({ graph }: { graph: TaskGraphSnapshot }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const layout = useMemo(() => graphLayout(graph), [graph])
  const related = useMemo(() => selected ? connectedNodeIds(graph, selected) : null, [graph, selected])
  return <div className="relative min-w-max overflow-hidden rounded-lg border border-border/50 bg-muted/10" style={{ width: layout.width, height: layout.height }} data-testid="task-graph-view">
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
      <defs>
        <marker id="todo-graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {graph.edges.map((edge) => {
        const from = layout.byId.get(edge.from); const to = layout.byId.get(edge.to)
        if (!from || !to) return null
        const x1 = from.x + GRAPH_NODE_WIDTH; const y1 = from.y + GRAPH_NODE_HEIGHT / 2
        const x2 = to.x; const y2 = to.y + GRAPH_NODE_HEIGHT / 2
        const bend = Math.max(36, (x2 - x1) * 0.46)
        const highlighted = selected === null || (related?.has(edge.from) && related.has(edge.to))
        return <path key={`${edge.from}-${edge.to}`} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
          fill="none" stroke="currentColor" strokeWidth={highlighted ? 2 : 1.25} markerEnd="url(#todo-graph-arrow)"
          className={cn('text-border transition-opacity', highlighted ? 'opacity-90' : 'opacity-15', selected && highlighted && 'text-sky-500')} />
      })}
    </svg>
    {layout.nodes.map(({ node, x, y }) => {
      const dimmed = related !== null && !related.has(node.id)
      const blocked = graph.blocked.some((item) => item.id === node.id)
      return <button key={node.id} type="button" onClick={() => setSelected((current) => current === node.id ? null : node.id)}
        className={cn('absolute flex flex-col rounded-lg border bg-background px-3 py-2 text-left shadow-sm transition-all hover:shadow-md',
          node.status === 'completed' && 'border-emerald-500/60', node.status === 'in_progress' && 'border-sky-500 ring-1 ring-sky-500/20',
          blocked && 'border-amber-500/60', node.status === 'cancelled' && 'border-dashed opacity-60', selected === node.id && 'ring-2 ring-sky-500', dimmed && 'opacity-25')}
        style={{ left: x, top: y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }} data-node-id={node.id}>
        <span className="line-clamp-2 text-xs font-medium leading-snug">{node.content}</span>
        <span className="mt-auto flex items-center gap-1.5 text-[10px] text-muted-foreground"><StatusIcon status={node.status} blocked={blocked} /><code className="truncate">{node.id}</code></span>
      </button>
    })}
  </div>
}

function graphLayout(graph: TaskGraphSnapshot): { nodes: PositionedNode[]; byId: Map<string, PositionedNode>; width: number; height: number } {
  const levels = graphLevels(graph)
  const maxRows = Math.max(1, ...levels.map((level) => level.length))
  const height = GRAPH_PADDING * 2 + maxRows * GRAPH_NODE_HEIGHT + (maxRows - 1) * GRAPH_ROW_GAP
  const nodes: PositionedNode[] = []
  levels.forEach((level, column) => {
    const columnHeight = level.length * GRAPH_NODE_HEIGHT + Math.max(0, level.length - 1) * GRAPH_ROW_GAP
    const startY = (height - columnHeight) / 2
    level.forEach((node, row) => nodes.push({ node, x: GRAPH_PADDING + column * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP), y: startY + row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP) }))
  })
  const width = GRAPH_PADDING * 2 + levels.length * GRAPH_NODE_WIDTH + Math.max(0, levels.length - 1) * GRAPH_COLUMN_GAP
  return { nodes, byId: new Map(nodes.map((item) => [item.node.id, item])), width, height }
}

function connectedNodeIds(graph: TaskGraphSnapshot, selected: string): Set<string> {
  const connected = new Set([selected])
  for (const edge of graph.edges) {
    if (edge.from === selected) connected.add(edge.to)
    if (edge.to === selected) connected.add(edge.from)
  }
  return connected
}

function graphLevels(graph: TaskGraphSnapshot): TaskGraphNode[][] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const level = new Map<string, number>()
  const visit = (id: string): number => {
    const cached = level.get(id); if (cached !== undefined) return cached
    const parents = graph.edges.filter((edge) => edge.to === id).map((edge) => edge.from)
    const value = parents.length ? Math.max(...parents.map(visit)) + 1 : 0
    level.set(id, value); return value
  }
  graph.nodes.forEach((node) => visit(node.id))
  const out: TaskGraphNode[][] = []
  for (const [id, value] of level) { out[value] ??= []; out[value]!.push(byId.get(id)!) }
  return out
}

function StatusIcon({ status, blocked }: { status: TaskGraphStatus; blocked: boolean }): JSX.Element {
  const cls = 'mt-0.5 h-3.5 w-3.5 flex-none'
  if (blocked) return <LockKeyhole className={cn(cls, 'text-amber-600')} />
  if (status === 'completed') return <Check className={cn(cls, 'text-emerald-600')} />
  if (status === 'cancelled') return <X className={cn(cls, 'text-muted-foreground')} />
  if (status === 'in_progress') return <CircleDashed className={cn(cls, 'animate-pulse text-sky-600')} />
  return <Circle className={cn(cls, 'text-muted-foreground')} />
}
