import { Check, ChevronDown, ChevronRight, Circle, CircleDashed, X } from 'lucide-react'
import { useState } from 'react'

import type { TodoItem, TodoStatus } from '@agent-kernel/kernel'

import { cn } from '../../lib/utils.js'

type Props = {
  todos: readonly TodoItem[]
}

/**
 * Session-scoped todo dock. Sits between the chat and the composer, collapsed
 * by default. The list is populated when the agent calls the `todowrite`
 * builtin  -  the kernel promotes that tool's input to `state.todos` (see
 * core.ts). The UI is read-only: users don't edit these directly, the agent
 * writes them and the user watches progress.
 */
export function TodoDock({ todos }: Props): JSX.Element | null {
  const [open, setOpen] = useState(true)
  if (todos.length === 0) return null

  const total = todos.length
  const completed = todos.filter(
    (t) => t.status === 'completed' || t.status === 'cancelled',
  ).length
  const active = todos.find((t) => t.status === 'in_progress')

  return (
    <div
      className="bg-muted dark:bg-card/60"
      data-testid="todo-dock"
    >
      <button
        type="button"
        className="w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-secondary dark:hover:bg-secondary/60"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="todo-dock-toggle"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground dark:text-muted-foreground flex-none" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground dark:text-muted-foreground flex-none" />
        )}
        <span
          className="font-medium text-foreground dark:text-foreground"
          data-testid="todo-dock-progress"
        >
          {completed}/{total} tasks
        </span>
        {!open && active ? (
          <span
            className="truncate text-xs text-muted-foreground dark:text-muted-foreground flex-1 text-left"
            data-testid="todo-dock-active-preview"
          >
            {active.content}
          </span>
        ) : null}
      </button>
      {open ? (
        <ul
          className="px-3 pb-3 pt-0 flex flex-col gap-1"
          data-testid="todo-dock-list"
        >
          {todos.map((todo, i) => (
            <TodoRow key={i} todo={todo} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function TodoRow({ todo }: { todo: TodoItem }): JSX.Element {
  const strike = todo.status === 'completed' || todo.status === 'cancelled'
  return (
    <li
      className="flex items-start gap-2 text-sm py-0.5"
      data-testid="todo-dock-item"
      data-status={todo.status}
      data-priority={todo.priority ?? ''}
    >
      <StatusIcon status={todo.status} />
      <span
        className={cn(
          'flex-1 min-w-0',
          strike && 'line-through text-muted-foreground dark:text-muted-foreground',
          todo.status === 'in_progress' &&
            'text-foreground dark:text-foreground font-medium',
          todo.status === 'pending' && 'text-foreground dark:text-muted-foreground',
        )}
      >
        {todo.content}
      </span>
      {todo.priority ? (
        <span
          className={cn(
            'flex-none text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded',
            todo.priority === 'high' &&
              'bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300',
            todo.priority === 'medium' &&
              'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300',
            todo.priority === 'low' &&
              'bg-muted dark:bg-secondary text-muted-foreground dark:text-muted-foreground',
          )}
        >
          {todo.priority}
        </span>
      ) : null}
    </li>
  )
}

function StatusIcon({ status }: { status: TodoStatus }): JSX.Element {
  const cls = 'h-4 w-4 mt-0.5 flex-none'
  if (status === 'completed') {
    return <Check className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />
  }
  if (status === 'cancelled') {
    return <X className={cn(cls, 'text-muted-foreground dark:text-muted-foreground')} />
  }
  if (status === 'in_progress') {
    return (
      <CircleDashed
        className={cn(cls, 'text-sky-600 dark:text-sky-400 animate-pulse')}
      />
    )
  }
  return <Circle className={cn(cls, 'text-muted-foreground dark:text-muted-foreground')} />
}
