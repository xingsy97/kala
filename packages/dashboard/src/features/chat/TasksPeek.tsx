/**
 * TasksPeek  -  a collapsed pill anchored top-right of the chat pane that shows
 * the agent's todo list. Auto-expands for 5s whenever todos change so the user
 * can catch state transitions without opening anything; auto-collapses after
 * the window elapses. Hover pauses the countdown. Clicking the pill locks it
 * into a "sticky" expanded mode until the user clicks again.
 *
 * The panel expands/collapses with a short opacity+translate+scale transition;
 * it stays mounted for EXIT_MS after collapse so the reverse animation plays.
 *
 * See packages/dashboard/docs/chat-panel-design.md  -  4 for the full spec.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, Circle, CircleDashed, X } from 'lucide-react'

import type { TodoItem, TodoStatus } from '@agent-kernel/kernel'

import { cn } from '../../lib/utils.js'

type Props = {
  todos: readonly TodoItem[]
  peekMs?: number
}

type Mode = 'collapsed' | 'peek' | 'sticky'

const DEFAULT_PEEK_MS = 5000
const TICK_MS = 200
// Exit animation duration  -  must match the CSS transition below. Panel stays
// mounted for this long after `expanded` flips to false so the reverse
// animation can play.
const EXIT_MS = 180

export function TasksPeek({ todos, peekMs = DEFAULT_PEEK_MS }: Props): JSX.Element | null {
  const [mode, setMode] = useState<Mode>('collapsed')
  // Keep the panel mounted for EXIT_MS after collapse so the reverse animation
  // can play. Independent from `mode` so the collapse/expand state can flip
  // instantly while the DOM lags behind.
  const [panelMounted, setPanelMounted] = useState(false)
  // Absolute Date.now() at which the current peek should auto-collapse. `null`
  // means "not counting down" (either collapsed, sticky, or hover-frozen).
  const expiresAtRef = useRef<number | null>(null)
  // Ms remaining when hover started, restored on hover leave.
  const remainingOnHoverRef = useRef<number | null>(null)
  const prevTodosSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    const signature = todoSignature(todos)
    const prev = prevTodosSignatureRef.current
    prevTodosSignatureRef.current = signature
    // First render initializes the ref without triggering a peek  -  otherwise
    // navigating to a session with a pre-populated todo list would auto-open.
    if (prev === null) return
    if (prev === signature) return
    // Sliding window: any change (even in sticky) refreshes the timer if we're
    // already peeking. Sticky ignores the change since the user is in charge.
    setMode((m) => {
      if (m === 'sticky') return 'sticky'
      expiresAtRef.current = Date.now() + peekMs
      remainingOnHoverRef.current = null
      return 'peek'
    })
  }, [todos, peekMs])

  useEffect(() => {
    if (mode !== 'peek') return
    const id = window.setInterval(() => {
      const exp = expiresAtRef.current
      // Hover-frozen: expiresAt is null. Wait for hover leave to restart.
      if (exp === null) return
      if (Date.now() >= exp) {
        expiresAtRef.current = null
        setMode('collapsed')
      }
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [mode])

  // Mount/unmount the panel with an exit-animation delay. When entering an
  // expanded mode we mount immediately; when leaving we wait EXIT_MS before
  // unmounting so the reverse transition can play.
  useEffect(() => {
    const shouldShow = mode === 'peek' || mode === 'sticky'
    if (shouldShow) {
      setPanelMounted(true)
      return
    }
    const id = window.setTimeout(() => setPanelMounted(false), EXIT_MS)
    return () => window.clearTimeout(id)
  }, [mode])

  const onMouseEnter = (): void => {
    if (mode !== 'peek') return
    const exp = expiresAtRef.current
    if (exp !== null) {
      remainingOnHoverRef.current = Math.max(0, exp - Date.now())
      expiresAtRef.current = null
    }
  }

  const onMouseLeave = (): void => {
    if (mode !== 'peek') return
    const remaining = remainingOnHoverRef.current
    if (remaining !== null) {
      expiresAtRef.current = Date.now() + remaining
      remainingOnHoverRef.current = null
    }
  }

  const onClick = (): void => {
    if (mode === 'sticky') {
      setMode('collapsed')
      expiresAtRef.current = null
      remainingOnHoverRef.current = null
      return
    }
    // From either 'collapsed' or 'peek', a manual click means "I want this
    // open  -  stop the auto timer".
    setMode('sticky')
    expiresAtRef.current = null
    remainingOnHoverRef.current = null
  }

  if (todos.length === 0) return null

  const expanded = mode === 'peek' || mode === 'sticky'
  const total = todos.length
  const done = todos.filter(
    (t) => t.status === 'completed' || t.status === 'cancelled',
  ).length
  const hasActive = todos.some((t) => t.status === 'in_progress')
  const allDone = done === total

  return (
    <div
      className="pointer-events-none absolute right-2 top-2 z-10 flex max-w-[min(22rem,calc(100%-1rem))] flex-col items-end gap-1"
      data-testid="tasks-peek"
      data-mode={mode}
    >
      <button
        type="button"
        className={cn(
          'pointer-events-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm backdrop-blur transition-colors',
          allDone
            ? 'border-emerald-300/60 bg-emerald-50/90 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-950/70 dark:text-emerald-200'
            : 'border-border/60 bg-background/90 text-foreground hover:bg-muted dark:bg-card/85',
        )}
        onClick={onClick}
        data-testid="tasks-peek-toggle"
        aria-expanded={expanded}
        aria-label={`Tasks: ${done} of ${total} done`}
      >
        {hasActive ? (
          <span
            className="h-1.5 w-1.5 flex-none rounded-full bg-sky-500 animate-pulse dark:bg-sky-400"
            aria-hidden="true"
          />
        ) : null}
        <span>Tasks</span>
        <span className="tabular-nums text-muted-foreground dark:text-muted-foreground">
           -  {done}/{total}
        </span>
      </button>
      {panelMounted ? (
        <div
          className={cn(
            'pointer-events-auto w-72 max-w-full overflow-hidden rounded-lg border border-border/60 bg-background/95 shadow-lg backdrop-blur dark:bg-card/95',
            'origin-top transition-[opacity,transform,max-height] duration-200 ease-out',
            'motion-reduce:transition-none',
            expanded
              ? 'opacity-100 translate-y-0 scale-y-100 max-h-[60vh]'
              : 'opacity-0 -translate-y-1 scale-y-95 max-h-0',
          )}
          data-testid="tasks-peek-panel"
          data-open={expanded ? 'true' : 'false'}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          <ul
            className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto px-2 py-2"
            data-testid="tasks-peek-list"
          >
            {todos.map((todo, i) => (
              <TaskRow key={i} todo={todo} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function todoSignature(todos: readonly TodoItem[]): string {
  return JSON.stringify(todos.map((todo) => [todo.status, todo.content]))
}

function TaskRow({ todo }: { todo: TodoItem }): JSX.Element {
  const strike = todo.status === 'completed' || todo.status === 'cancelled'
  return (
    <li
      className="flex items-start gap-2 rounded px-1.5 py-1 text-[13px]"
      data-testid="tasks-peek-item"
      data-status={todo.status}
    >
      <StatusIcon status={todo.status} />
      <span
        className={cn(
          'min-w-0 flex-1 leading-snug',
          strike && 'text-muted-foreground line-through dark:text-muted-foreground',
          todo.status === 'in_progress' && 'font-medium text-foreground',
          todo.status === 'pending' && 'text-foreground dark:text-muted-foreground',
        )}
      >
        {todo.content}
      </span>
    </li>
  )
}

function StatusIcon({ status }: { status: TodoStatus }): JSX.Element {
  const cls = 'mt-0.5 h-3.5 w-3.5 flex-none'
  if (status === 'completed') {
    return <Check className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />
  }
  if (status === 'cancelled') {
    return <X className={cn(cls, 'text-muted-foreground')} />
  }
  if (status === 'in_progress') {
    return <CircleDashed className={cn(cls, 'text-sky-600 animate-pulse dark:text-sky-400')} />
  }
  return <Circle className={cn(cls, 'text-muted-foreground')} />
}
