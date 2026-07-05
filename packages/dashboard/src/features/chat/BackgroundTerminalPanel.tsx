import { TerminalSquare } from 'lucide-react'

import type { BackgroundTerminalTask } from '../../background-terminal.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'

type Props = {
  tasks: readonly BackgroundTerminalTask[]
}

export function BackgroundTerminalPanel({ tasks }: Props): JSX.Element | null {
  if (tasks.length === 0) return null
  return (
    <div
      className="border-t border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950"
      data-testid="background-terminal-panel"
    >
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
        <TerminalSquare className="h-4 w-4" />
        <span className="font-medium">Background terminal</span>
        <span className="ml-auto text-[11px] text-slate-500">
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
      </div>
      <ScrollArea className="max-h-44 border-t border-slate-200 dark:border-slate-800">
        <div className="space-y-2 p-3">
          {tasks.map((task) => (
            <BackgroundTaskRow key={task.taskId} task={task} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function BackgroundTaskRow({ task }: { task: BackgroundTerminalTask }): JSX.Element {
  return (
    <div className="rounded border border-slate-200 bg-white text-xs dark:border-slate-800 dark:bg-slate-900/70">
      <div className="flex min-w-0 items-center gap-2 border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
        <span className={cn('h-2 w-2 flex-none rounded-full', statusDot(task.status))} />
        <span className="min-w-0 flex-1 truncate font-mono text-slate-800 dark:text-slate-100">
          {task.command}
        </span>
        <span className="flex-none rounded bg-slate-100 px-1.5 py-0.5 text-[11px] capitalize text-slate-600 dark:bg-slate-950 dark:text-slate-300">
          {task.status}
        </span>
      </div>
      <div className="flex min-w-0 gap-2 px-2 py-1 text-[11px] text-slate-500">
        <span className="min-w-0 truncate font-mono">task {task.taskId}</span>
        {task.cwd ? <span className="min-w-0 truncate font-mono">cwd {task.cwd}</span> : null}
      </div>
      {task.output.length > 0 ? (
        <ScrollArea className="max-h-24 border-t border-slate-200 bg-slate-950 text-slate-100 dark:border-slate-800">
          <pre className="min-w-max whitespace-pre-wrap p-2 font-mono text-[11px] leading-relaxed">
            {task.output}
          </pre>
        </ScrollArea>
      ) : (
        <div className="border-t border-slate-200 px-2 py-2 text-[11px] text-slate-500 dark:border-slate-800">
          No output captured yet. Ask the agent to call bash_output with this task id.
        </div>
      )}
    </div>
  )
}

function statusDot(status: BackgroundTerminalTask['status']): string {
  if (status === 'running') return 'bg-sky-500'
  if (status === 'done') return 'bg-emerald-500'
  if (status === 'killed') return 'bg-amber-500'
  return 'bg-slate-400'
}
