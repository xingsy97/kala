import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'

type WizardStep = 'tasks' | 'agent' | 'import'

const STEPS: readonly WizardStep[] = ['tasks', 'agent', 'import']

type ResolveTasksResponse = { action: string; runId: string; taskCount: number }
type RunAgentResponse = {
  action: string
  runId: string
  total: number
  resolved: number
  unresolved: number
  errored: number
  accuracy: number
  durationMs: number
}
type ImportResultsResponse = {
  action: string
  runId: string
  total: number
  resolved: number
  unresolved: number
  errored: number
  accuracy?: number
}
type ProgressResponse = {
  action: string
  runId: string
  status: string
  total: number
  completed: number
  resolved?: number
  unresolved?: number
  errored?: number
  currentTask?: string
  lastUpdatedAt: string | null
}

// A benchmark wizard variant. `terminal-bench` keeps the original 3-step
// resolve/agent/import flow (JSONL tasks). The container-backed benchmarks
// (program-bench, swe-marathon, terminal-bench 2.1) run in one step: they take
// a task source and a run action that both executes and scores, then optionally
// re-import. This single component drives all of them so CLI, HTTP, and Web
// stay in lockstep.
export type BenchmarkWizardVariant =
  | 'terminal-bench'
  | 'program-bench'
  | 'swe-marathon'
  | 'terminal-bench-2_1'

type VariantConfig = {
  titleKey: string
  descriptionKey: string
  /** How tasks are supplied: inline JSONL content, or a server-side directory. */
  taskSource: 'jsonl' | 'dir'
  resolveAction?: string
  runAction: string
  importAction?: string
  progressAction?: string
  /** Field name for the run action's task input. */
  taskField: 'tasksContent' | 'tasksJsonl' | 'tasksDir'
  /** Whether the run action accepts an agentCommand. */
  usesAgentCommand: boolean
  defaultAgentCommand: string
}

const VARIANTS: Record<BenchmarkWizardVariant, VariantConfig> = {
  'terminal-bench': {
    titleKey: 'benchmarks.terminalWizard.title',
    descriptionKey: 'benchmarks.terminalWizard.description',
    taskSource: 'jsonl',
    resolveAction: 'terminal-bench-resolve-tasks',
    runAction: 'terminal-bench-run-agent',
    importAction: 'terminal-bench-import-results',
    progressAction: 'terminal-bench-read-progress',
    taskField: 'tasksContent',
    usesAgentCommand: true,
    defaultAgentCommand: 'true',
  },
  'program-bench': {
    titleKey: 'benchmarks.programWizard.title',
    descriptionKey: 'benchmarks.programWizard.description',
    taskSource: 'jsonl',
    runAction: 'program-bench-run-agent',
    importAction: 'program-bench-import-results',
    taskField: 'tasksContent',
    usesAgentCommand: true,
    defaultAgentCommand: 'true',
  },
  'swe-marathon': {
    titleKey: 'benchmarks.marathonWizard.title',
    descriptionKey: 'benchmarks.marathonWizard.description',
    taskSource: 'dir',
    runAction: 'swe-marathon-run-agent',
    importAction: 'swe-marathon-import-results',
    taskField: 'tasksDir',
    usesAgentCommand: false,
    defaultAgentCommand: '',
  },
  'terminal-bench-2_1': {
    titleKey: 'benchmarks.terminal21Wizard.title',
    descriptionKey: 'benchmarks.terminal21Wizard.description',
    taskSource: 'dir',
    runAction: 'terminal-bench-2_1-run',
    taskField: 'tasksDir',
    usesAgentCommand: true,
    defaultAgentCommand: 'solution',
  },
}

export function RunTerminalBenchWizard({
  open,
  onOpenChange,
  onRunRegistered,
  variant = 'terminal-bench',
}: {
  open: boolean
  onOpenChange(open: boolean): void
  onRunRegistered(runId: string): void
  variant?: BenchmarkWizardVariant
}): JSX.Element {
  const cfg = VARIANTS[variant]
  const { t } = useTranslation()
  const [step, setStep] = useState<WizardStep>('tasks')
  const [runId, setRunId] = useState('')
  const [tasksContent, setTasksContent] = useState('')
  const [tasksDir, setTasksDir] = useState('')
  const [agentCommand, setAgentCommand] = useState(cfg.defaultAgentCommand)
  const [tasksResolved, setTasksResolved] = useState<number | null>(null)
  const [agentSummary, setAgentSummary] = useState<RunAgentResponse | null>(null)
  const [importSummary, setImportSummary] = useState<ImportResultsResponse | null>(null)
  const [progress, setProgress] = useState<ProgressResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function callAction<T>(payload: Record<string, unknown>): Promise<T> {
    const res = await fetch('/enhancement/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
    if (!res.ok) throw new Error(body?.error ?? `status ${res.status}`)
    return body as T
  }

  async function resolveTasks(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      // Variants without a dedicated resolve action skip straight to the run
      // step; we still validate the task source is present.
      if (cfg.resolveAction) {
        const result = await callAction<ResolveTasksResponse>({
          action: cfg.resolveAction,
          runId: runId.trim(),
          tasksContent,
        })
        setTasksResolved(result.taskCount)
      } else {
        setTasksResolved(0)
      }
      setStep('agent')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function runTaskPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { action: cfg.runAction, runId: runId.trim() }
    if (cfg.taskField === 'tasksContent') payload.tasksContent = tasksContent
    else if (cfg.taskField === 'tasksJsonl') payload.tasksJsonl = tasksContent.trim()
    else payload.tasksDir = tasksDir.trim()
    if (cfg.usesAgentCommand) payload.agentCommand = agentCommand.trim() || cfg.defaultAgentCommand
    return payload
  }

  async function runAgent(): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      let stopped = false
      const poll = async (): Promise<void> => {
        if (!cfg.progressAction) return
        while (!stopped) {
          try {
            const p = await callAction<ProgressResponse>({ action: cfg.progressAction, runId: runId.trim() })
            setProgress(p)
          } catch {
            // Progress read may 404 until the first snapshot; keep polling.
          }
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      const pollPromise = poll()
      const result = await callAction<RunAgentResponse>(runTaskPayload())
      stopped = true
      await pollPromise
      setAgentSummary(result)
      // Variants without a separate import action are complete after the run.
      if (cfg.importAction) {
        setStep('import')
      } else {
        onRunRegistered(runId.trim())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function importResults(): Promise<void> {
    if (!cfg.importAction) return
    setError(null)
    setBusy(true)
    try {
      const result = await callAction<ImportResultsResponse>({ action: cfg.importAction, runId: runId.trim() })
      setImportSummary(result)
      onRunRegistered(runId.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const taskSourceReady = cfg.taskSource === 'jsonl' ? tasksContent.trim().length > 0 : tasksDir.trim().length > 0
  const canResolve = runId.trim().length > 0 && taskSourceReady && !busy
  const canRunAgent = tasksResolved !== null && !busy
  const canImport = agentSummary !== null && !busy
  const visibleSteps = cfg.importAction ? STEPS : STEPS.filter((s) => s !== 'import')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="terminalbench-wizard">
        <DialogHeader>
          <DialogTitle>{t(cfg.titleKey)}</DialogTitle>
          <DialogDescription>{t(cfg.descriptionKey)}</DialogDescription>
        </DialogHeader>

        <ol className="flex items-center gap-2 text-xs" data-testid="terminalbench-wizard-steps">
          {visibleSteps.map((id, i) => (
            <li key={id} className="flex items-center gap-1">
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full text-[10px]',
                  step === id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {i + 1}
              </span>
              <span
                className={cn(step === id ? 'font-semibold text-foreground' : 'text-muted-foreground')}
                data-testid={`terminalbench-wizard-step-label-${id}`}
              >
                {t(`benchmarks.terminalWizard.steps.${id === 'tasks' ? 'chooseTasks' : id === 'agent' ? 'runAgent' : 'importResults'}`)}
              </span>
            </li>
          ))}
        </ol>

        {error ? (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" data-testid="terminalbench-wizard-error">
            {t('benchmarks.terminalWizard.error', { message: error })}
          </div>
        ) : null}

        {step === 'tasks' ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('benchmarks.terminalWizard.runIdLabel')}</span>
              <input
                type="text"
                className="rounded border border-border bg-background px-2 py-1 text-sm"
                placeholder={t('benchmarks.terminalWizard.runIdPlaceholder')}
                value={runId}
                onChange={(e) => setRunId(e.target.value)}
                data-testid="terminalbench-wizard-runid"
              />
            </label>
            {cfg.taskSource === 'jsonl' ? (
              <>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">{t('benchmarks.terminalWizard.tasksLabel')}</span>
                  <textarea
                    className="min-h-[120px] rounded border border-border bg-background p-2 font-mono text-xs"
                    placeholder={t('benchmarks.terminalWizard.tasksPlaceholder')}
                    value={tasksContent}
                    onChange={(e) => setTasksContent(e.target.value)}
                    data-testid="terminalbench-wizard-tasks"
                  />
                </label>
                <input
                  type="file"
                  accept=".jsonl,.json,.txt"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const text = await file.text()
                    setTasksContent(text)
                  }}
                  data-testid="terminalbench-wizard-upload"
                  className="text-xs"
                  aria-label={t('benchmarks.terminalWizard.tasksUpload')}
                />
              </>
            ) : (
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">{t('benchmarks.terminalWizard.tasksDirLabel')}</span>
                <input
                  type="text"
                  className="rounded border border-border bg-background px-2 py-1 text-sm font-mono"
                  placeholder={t('benchmarks.terminalWizard.tasksDirPlaceholder')}
                  value={tasksDir}
                  onChange={(e) => setTasksDir(e.target.value)}
                  data-testid="terminalbench-wizard-tasksdir"
                />
              </label>
            )}
            {tasksResolved !== null && cfg.resolveAction ? (
              <div className="text-xs text-emerald-600" data-testid="terminalbench-wizard-tasks-resolved">
                {t('benchmarks.terminalWizard.tasksResolved', { count: tasksResolved })}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => { void resolveTasks() }}
                disabled={!canResolve}
                data-testid="terminalbench-wizard-next-tasks"
              >
                {t('benchmarks.terminalWizard.next')}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 'agent' ? (
          <div className="flex flex-col gap-3">
            {cfg.usesAgentCommand ? (
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">{t('benchmarks.terminalWizard.agentCommandLabel')}</span>
                <input
                  type="text"
                  className="rounded border border-border bg-background px-2 py-1 text-sm font-mono"
                  placeholder={t('benchmarks.terminalWizard.agentCommandPlaceholder')}
                  value={agentCommand}
                  onChange={(e) => setAgentCommand(e.target.value)}
                  data-testid="terminalbench-wizard-agent-command"
                />
                <span className="text-[10px] text-muted-foreground">{t('benchmarks.terminalWizard.agentCommandHint')}</span>
              </label>
            ) : null}
            {progress ? (
              <div className="text-xs text-muted-foreground" data-testid="terminalbench-wizard-progress">
                {t('benchmarks.terminalWizard.runAgentProgress', { completed: progress.completed, total: progress.total })}
              </div>
            ) : null}
            {agentSummary ? (
              <div className="text-xs text-emerald-600" data-testid="terminalbench-wizard-agent-done">
                {t('benchmarks.terminalWizard.runAgentDone', { completed: agentSummary.total, total: agentSummary.total })}
              </div>
            ) : null}
            <div className="flex justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep('tasks')} data-testid="terminalbench-wizard-back-agent">
                {t('benchmarks.terminalWizard.back')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => { void runAgent() }}
                disabled={!canRunAgent}
                data-testid="terminalbench-wizard-run-agent"
              >
                {t('benchmarks.terminalWizard.runAgentButton')}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 'import' && cfg.importAction ? (
          <div className="flex flex-col gap-3">
            {importSummary ? (
              <div className="text-sm text-emerald-600" data-testid="terminalbench-wizard-import-done">
                {t('benchmarks.terminalWizard.importDone', { resolved: importSummary.resolved, total: importSummary.total })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('benchmarks.terminalWizard.importHint')}</p>
            )}
            <div className="flex justify-between gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep('agent')} data-testid="terminalbench-wizard-back-import">
                {t('benchmarks.terminalWizard.back')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => { void importResults() }}
                disabled={!canImport}
                data-testid="terminalbench-wizard-import"
              >
                {t('benchmarks.terminalWizard.importButton')}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
