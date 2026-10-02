import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { CalendarClock, History, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import {
  createScheduledTasksClient,
  type ScheduleSpec,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskTarget,
  type ScheduledTasksClient,
} from '../../scheduled-tasks-client.js'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  host: string
  token?: string
  target: ScheduledTaskTarget | null
  client?: ScheduledTasksClient
  onOpenSession?(sessionId: string): void
}

type FormState = {
  prompt: string
  kind: ScheduleSpec['kind']
  onceAt: string
  timezone: string
  time: string
  daysOfWeek: number[]
}

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function localDateTimeInput(date = new Date(Date.now() + 60 * 60 * 1000)): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

function initialForm(): FormState {
  const now = new Date()
  return {
    prompt: '',
    kind: 'once',
    onceAt: localDateTimeInput(),
    timezone: localTimezone(),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    daysOfWeek: [now.getDay()],
  }
}

function targetMatches(left: ScheduledTaskTarget, right: ScheduledTaskTarget): boolean {
  return left.kind === right.kind && (left.kind === 'session'
    ? left.sessionId === (right as Extract<ScheduledTaskTarget, { kind: 'session' }>).sessionId
    : left.workspaceId === (right as Extract<ScheduledTaskTarget, { kind: 'workspace' }>).workspaceId)
}

function scheduleFromForm(form: FormState): ScheduleSpec {
  if (form.kind === 'once') return { kind: 'once', at: new Date(form.onceAt).toISOString() }
  const [hour = 0, minute = 0] = form.time.split(':').map(Number)
  if (form.kind === 'daily') return { kind: 'daily', timezone: form.timezone, hour, minute }
  return { kind: 'weekly', timezone: form.timezone, daysOfWeek: form.daysOfWeek, hour, minute }
}

function formFromTask(task: ScheduledTask): FormState {
  const base = initialForm()
  if (task.schedule.kind === 'once') {
    return { ...base, prompt: task.prompt, kind: 'once', onceAt: localDateTimeInput(new Date(task.schedule.at)) }
  }
  const time = `${String(task.schedule.hour).padStart(2, '0')}:${String(task.schedule.minute).padStart(2, '0')}`
  return {
    ...base,
    prompt: task.prompt,
    kind: task.schedule.kind,
    timezone: task.schedule.timezone,
    time,
    daysOfWeek: task.schedule.kind === 'weekly' ? [...task.schedule.daysOfWeek] : base.daysOfWeek,
  }
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not scheduled'
}

function scheduleLabel(schedule: ScheduleSpec): string {
  if (schedule.kind === 'once') return `Once · ${formatDate(schedule.at)}`
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
  if (schedule.kind === 'daily') return `Daily · ${time} · ${schedule.timezone}`
  return `Weekly ${schedule.daysOfWeek.map((day) => DAYS[day]).join(', ')} · ${time} · ${schedule.timezone}`
}

export function ScheduledTasksTrigger({ target, onOpen, className, scope: requestedScope }: { target: ScheduledTaskTarget | null; onOpen(): void; className?: string; scope?: ScheduledTaskTarget['kind'] }): JSX.Element {
  const scope = target?.kind ?? requestedScope ?? 'session'
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={target === null}
      onClick={onOpen}
      className={className}
      aria-label={`Scheduled tasks for this ${scope}`}
      title={target === null ? 'Select a workspace first' : `Scheduled tasks for this ${scope}`}
      data-testid={`scheduled-tasks-${scope}-trigger`}
    >
      <CalendarClock className="mr-1.5 h-4 w-4" aria-hidden />
      Scheduled tasks
    </Button>
  )
}

export function ScheduledTasksDialog({ open, onOpenChange, host, token, target, client: suppliedClient, onOpenSession }: Props): JSX.Element {
  const client = useMemo(() => suppliedClient ?? createScheduledTasksClient({ host, ...(token ? { token } : {}) }), [host, suppliedClient, token])
  const [tasks, setTasks] = useState<readonly ScheduledTask[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(() => initialForm())
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null)
  const [history, setHistory] = useState<readonly ScheduledRun[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!target) return
    setLoading(true)
    setError(null)
    try {
      const all = await client.list()
      setTasks(all.filter((task) => targetMatches(task.target, target)))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [client, target])

  useEffect(() => {
    if (!open) return
    setEditingId(null)
    setForm(initialForm())
    setHistoryTaskId(null)
    setHistory([])
    void load()
  }, [load, open])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!target || !form.prompt.trim() || (form.kind === 'weekly' && form.daysOfWeek.length === 0)) return
    setSaving(true)
    setError(null)
    try {
      const draft = { prompt: form.prompt.trim(), target, schedule: scheduleFromForm(form) }
      if (editingId) await client.update(editingId, draft)
      else await client.create(draft)
      setEditingId(null)
      setForm(initialForm())
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await action()
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const showHistory = async (taskId: string): Promise<void> => {
    setHistoryTaskId(taskId)
    setHistoryLoading(true)
    setError(null)
    try {
      setHistory(await client.history(taskId))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }

  const scopeName = target?.kind === 'workspace' ? (target.workspaceName || 'workspace') : 'Session'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(dialogMobileSheetClassName, 'max-h-[min(52rem,calc(var(--ak-viewport-h,100dvh)-1rem))] max-w-3xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 gap-0')} data-testid="scheduled-tasks-dialog">
        <DialogHeader className="border-b border-border/50 px-5 py-4">
          <DialogTitle>Scheduled tasks · {scopeName}</DialogTitle>
          <DialogDescription>
            {target?.kind === 'session'
              ? 'Runs join this Session queue. If the Session is busy, the scheduled prompt waits behind existing work.'
              : target?.kind === 'workspace'
                ? 'Each run creates a fresh Session in this workspace.'
                : 'Select a Session or workspace to manage scheduled tasks.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid min-w-0 gap-5 px-4 py-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] sm:px-5">
          <form onSubmit={(event) => void submit(event)} className="space-y-3" aria-label={editingId ? 'Edit scheduled task' : 'Create scheduled task'}>
            <h3 className="text-sm font-semibold">{editingId ? 'Edit task' : 'Create task'}</h3>
            <label className="block text-xs font-medium text-muted-foreground">
              Prompt
              <textarea required value={form.prompt} onChange={(event) => setForm((prev) => ({ ...prev, prompt: event.target.value }))} rows={4} className="mt-1 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" />
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              Schedule
              <select value={form.kind} onChange={(event) => setForm((prev) => ({ ...prev, kind: event.target.value as ScheduleSpec['kind'] }))} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground">
                <option value="once">Once</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            {form.kind === 'once' ? (
              <label className="block text-xs font-medium text-muted-foreground">Date and time<input required type="datetime-local" value={form.onceAt} onChange={(event) => setForm((prev) => ({ ...prev, onceAt: event.target.value }))} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm" /></label>
            ) : (
              <>
                <label className="block text-xs font-medium text-muted-foreground">Time<input required type="time" value={form.time} onChange={(event) => setForm((prev) => ({ ...prev, time: event.target.value }))} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm" /></label>
                <label className="block text-xs font-medium text-muted-foreground">IANA timezone<input required list="scheduled-task-timezones" value={form.timezone} onChange={(event) => setForm((prev) => ({ ...prev, timezone: event.target.value }))} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm" /><datalist id="scheduled-task-timezones"><option value={localTimezone()} /><option value="UTC" /></datalist></label>
              </>
            )}
            {form.kind === 'weekly' ? (
              <fieldset><legend className="text-xs font-medium text-muted-foreground">Days</legend><div className="mt-1 flex flex-wrap gap-1">{DAYS.map((day, index) => <label key={day} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"><input type="checkbox" checked={form.daysOfWeek.includes(index)} onChange={(event) => setForm((prev) => ({ ...prev, daysOfWeek: event.target.checked ? [...prev.daysOfWeek, index].sort() : prev.daysOfWeek.filter((item) => item !== index) }))} />{day}</label>)}</div></fieldset>
            ) : null}
            <p className="text-xs text-muted-foreground">Next run is calculated by the Host and shown after saving.</p>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!target || saving || !form.prompt.trim() || (form.kind === 'weekly' && form.daysOfWeek.length === 0)}><Plus className="mr-1.5 h-4 w-4" aria-hidden />{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create task'}</Button>
              {editingId ? <Button type="button" size="sm" variant="ghost" onClick={() => { setEditingId(null); setForm(initialForm()) }}>Cancel</Button> : null}
            </div>
          </form>

          <section className="min-w-0 space-y-3" aria-label="Scheduled tasks list">
            <h3 className="text-sm font-semibold">Tasks</h3>
            {loading ? <p role="status" className="text-sm text-muted-foreground">Loading scheduled tasks…</p> : null}
            {error ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">{error}<Button type="button" variant="ghost" size="sm" onClick={() => void load()}>Retry</Button></div> : null}
            {!loading && !error && tasks.length === 0 ? <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">No scheduled tasks for this {target?.kind ?? 'target'}.</p> : null}
            {tasks.map((task) => (
              <article key={task.id} className="rounded-md border border-border/60 bg-card p-3" data-testid={`scheduled-task-${task.id}`}>
                <div className="flex items-start justify-between gap-2"><p className="line-clamp-3 whitespace-pre-wrap text-sm">{task.prompt}</p><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', task.status === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>{task.status}</span></div>
                <p className="mt-2 text-xs text-muted-foreground">{scheduleLabel(task.schedule)}</p>
                <p className="mt-1 text-xs"><span className="text-muted-foreground">Next run:</span> {formatDate(task.nextRunAt)}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  <Button type="button" variant="outline" size="sm" onClick={() => void runAction(() => task.status === 'active' ? client.pause(task.id) : client.resume(task.id))}>{task.status === 'active' ? <Pause className="mr-1 h-3.5 w-3.5" aria-hidden /> : <Play className="mr-1 h-3.5 w-3.5" aria-hidden />}{task.status === 'active' ? 'Pause' : 'Resume'}</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => { setEditingId(task.id); setForm(formFromTask(task)) }}><Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />Edit</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void showHistory(task.id)}><History className="mr-1 h-3.5 w-3.5" aria-hidden />History</Button>
                  <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => { if (window.confirm('Delete this scheduled task?')) void runAction(() => client.delete(task.id)) }}><Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />Delete</Button>
                </div>
                {historyTaskId === task.id ? (
                  <div className="mt-3 border-t border-border/50 pt-3" data-testid="scheduled-task-history">
                    {historyLoading ? <p role="status" className="text-xs text-muted-foreground">Loading history…</p> : history.length === 0 ? <p className="text-xs text-muted-foreground">No runs yet.</p> : (
                      <ul className="space-y-2">{history.map((run) => <li key={run.occurrenceId} className="rounded bg-muted/50 p-2 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{run.status.replace('_', ' ')}</span><time dateTime={run.scheduledFor}>{formatDate(run.scheduledFor)}</time></div>{run.sessionId ? <button type="button" className="mt-1 text-primary underline underline-offset-2" onClick={() => onOpenSession?.(run.sessionId!)}>Open Session {run.sessionId}</button> : null}{run.error ? <p className="mt-1 text-destructive">{run.error}</p> : null}</li>)}</ul>
                    )}
                  </div>
                ) : null}
              </article>
            ))}
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
