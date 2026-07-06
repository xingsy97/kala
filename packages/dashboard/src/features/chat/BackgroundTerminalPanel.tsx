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
      className="bg-muted"
      data-testid="background-terminal-panel"
    >
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <TerminalSquare className="h-4 w-4" />
        <span className="font-medium">Background terminal</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? '' : 's'}
        </span>
      </div>
      <ScrollArea className="max-h-44 border-t border-border/50">
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
    <div className="rounded border border-border/50 bg-card text-xs">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/50 px-2 py-1.5">
        <span className={cn('h-2 w-2 flex-none rounded-full', statusDot(task.status))} />
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">
          {task.command}
        </span>
        <span className="flex-none rounded bg-secondary px-1.5 py-0.5 text-[11px] capitalize text-muted-foreground">
          {task.status}
        </span>
      </div>
      <div className="flex min-w-0 gap-2 px-2 py-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate font-mono">task {task.taskId}</span>
        {task.cwd ? <span className="min-w-0 truncate font-mono">cwd {task.cwd}</span> : null}
      </div>
      {task.output.length > 0 ? (
        <ScrollArea className="max-h-24 border-t border-border/50 bg-background text-foreground">
          <pre className="min-w-max whitespace-pre-wrap p-2 font-mono text-[11px] leading-relaxed">
            {task.output}
          </pre>
        </ScrollArea>
      ) : (
        <div className="border-t border-border/50 px-2 py-2 text-[11px] text-muted-foreground">
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
  return 'bg-muted'
}
