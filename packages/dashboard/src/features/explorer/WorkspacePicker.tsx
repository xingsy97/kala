import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentRuntimeDescriptor, AgentRuntimeId, AttachedExecutor } from '@agent-kernel/shared'
import { KERNEL_AGENT_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'

import { Bot, Check, Sparkles, X } from 'lucide-react'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
  dialogTouchCloseClassName,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import type { DashboardSocket } from '../../session.js'
import { DirectoryPicker } from './DirectoryPicker.js'

type Props = {
  open: boolean
  workspaces: readonly AttachedExecutor[]
  agentRuntimes?: readonly AgentRuntimeDescriptor[]
  initialWorkspaceId?: string
  socket: DashboardSocket | null
  error?: string | null
  submitting?: boolean
  onCreate(input: {
    agentRuntime: AgentRuntimeId
    workspaceId: string
    workspaceName: string | undefined
    cwd: string
  }): void
  onCreateSimpleChat(agentRuntime: AgentRuntimeId): void
  onCancel(): void
}

export function NewSessionDialog({
  open,
  workspaces,
  agentRuntimes = [{
    id: 'kernel',
    label: 'Agent RunLab',
    description: 'Agent Kernel',
    available: true,
    status: 'ready',
    capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
  }],
  initialWorkspaceId,
  socket,
  error,
  submitting = false,
  onCreate,
  onCreateSimpleChat,
  onCancel,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [workspaceId, setWorkspaceId] = useState('')
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeId>('kernel')
  const [cwd, setCwd] = useState('')
  const [missingWorkspaceId, setMissingWorkspaceId] = useState<string | null>(null)
  const initializedOpenRef = useRef(false)
  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.workspaceId === workspaceId),
    [workspaceId, workspaces],
  )

  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false
      return
    }
    if (initializedOpenRef.current) return
    initializedOpenRef.current = true
    const preferredRuntime = agentRuntimes.find((runtime) => runtime.id === 'kernel' && runtime.available)
      ?? agentRuntimes.find((runtime) => runtime.available)
    setAgentRuntime(preferredRuntime?.id ?? 'kernel')
    if (initialWorkspaceId) {
      const initial = workspaces.find((w) => w.workspaceId === initialWorkspaceId)
      setWorkspaceId(initialWorkspaceId)
      setCwd(initial ? initialPathFor(initial) : '')
      return
    }
    const first = workspaces[0]
    setWorkspaceId(first?.workspaceId ?? '')
    setCwd(first ? initialPathFor(first) : '')
  }, [agentRuntimes, initialWorkspaceId, open, workspaces])

  useEffect(() => {
    if (!open) return
    if (!workspaceId) {
      setMissingWorkspaceId(null)
      return
    }
    const workspace = workspaces.find((w) => w.workspaceId === workspaceId)
    setMissingWorkspaceId(workspace ? null : workspaceId)
    if (!workspace) setCwd('')
    else setCwd((prev) => (prev.trim().length === 0 ? initialPathFor(workspace) : prev))
  }, [open, workspaceId, workspaces])

  const selectWorkspace = (id: string): void => {
    const workspace = workspaces.find((w) => w.workspaceId === id)
    setWorkspaceId(id)
    setMissingWorkspaceId(workspace ? null : id)
    setCwd(workspace ? initialPathFor(workspace) : '')
  }

  const create = (): void => {
    if (submitting || !selectedWorkspace || cwd.trim().length === 0) return
    onCreate({
      agentRuntime,
      workspaceId: selectedWorkspace.workspaceId,
      workspaceName: selectedWorkspace.workspaceName,
      cwd: cwd.trim(),
    })
  }

  const initialPath = selectedWorkspace ? initialPathFor(selectedWorkspace) : undefined

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onCancel() }}>
      <DialogContent className={cn(dialogMobileSheetClassName, 'h-[min(calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-0.5rem),48rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden p-0 sm:max-w-4xl')} data-testid="new-session-dialog">
        <DialogHeader className="relative border-b border-border/50 px-4 py-2 pr-14 sm:py-3">
          <DialogTitle>{t('dialogs.newSession')}</DialogTitle>
          <DialogDescription className="hidden sm:block">
            {t('dialogs.newSessionDescription')}
          </DialogDescription>
          <DialogClose className={dialogTouchCloseClassName} disabled={submitting} aria-label={t('common.close')} data-testid="new-session-close">
            <X className="h-4 w-4" aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <section className="border-b border-border/50 bg-muted/20 px-4 py-3" aria-labelledby="new-session-runtime-label">
          <div id="new-session-runtime-label" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('dialogs.chooseAgentRuntime')}
          </div>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="new-session-runtime-label">
            {agentRuntimes.map((runtime) => {
              const selected = agentRuntime === runtime.id
              const RuntimeIcon = runtime.id === 'copilot' ? Sparkles : Bot
              return (
                <button
                  key={runtime.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={submitting || !runtime.available}
                  onClick={() => setAgentRuntime(runtime.id)}
                  data-testid={`new-session-runtime-${runtime.id}`}
                  className={cn(
                    'relative flex min-h-20 items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                    selected
                      ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary/30'
                      : 'border-border bg-card text-foreground hover:border-primary/50 hover:bg-accent/50',
                    !runtime.available && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <span className={cn('mt-0.5 rounded-lg p-2', selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                    <RuntimeIcon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 font-semibold">
                      {runtime.label}
                      {selected ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      {runtime.available ? runtime.description : runtime.reason ?? runtime.status}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="flex min-h-0 flex-col border-b border-border/50 bg-muted/60 md:border-b-0 md:border-r md:bg-muted">
            <div className="px-2 pt-2 max-md:hidden">
              <button
                type="button"
                data-testid="new-session-simple-chat"
                disabled={submitting}
                onClick={() => onCreateSimpleChat(agentRuntime)}
                className="w-full rounded-md border border-dashed border-primary/50 bg-primary/5 px-2 py-2 text-left transition-colors hover:bg-primary/10 disabled:opacity-50"
              >
                <div className="truncate text-sm font-medium text-foreground">
                  {t('dialogs.simpleChat')}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {t('dialogs.simpleChatDescription')}
                </div>
              </button>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground"><span>{t('dialogs.workspaceSessions')}</span><button type="button" disabled={submitting} onClick={() => onCreateSimpleChat(agentRuntime)} className="ml-auto rounded px-2 py-1 text-primary hover:bg-primary/10 md:hidden">{t('dialogs.simpleChat')}</button></div>
            <ScrollArea className="min-h-0 flex-1 max-md:max-h-24">
              <div className="flex gap-2 px-2 pb-2 md:block md:space-y-1">
                {workspaces.length === 0 ? (
                  <div className="rounded border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                    {t('dialogs.noExecutorOnline')}
                  </div>
                ) : null}
                {missingWorkspaceId ? (
                  <div
                    className="rounded border border-amber-300/70 bg-amber-50 px-3 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                    data-testid="new-session-missing-workspace"
                  >
                    {t('dialogs.selectedWorkspaceOffline')}
                  </div>
                ) : null}
                {workspaces.map((w) => (
                  <button
                    key={w.workspaceId}
                    type="button"
                    data-testid={`workspace-pick-${w.workspaceId}`}
                    onClick={() => selectWorkspace(w.workspaceId)}
                    className={cn(
                      'min-w-[13rem] flex-1 rounded-md border px-2 py-2 text-left transition-colors md:w-full md:min-w-0',
                      workspaceId === w.workspaceId
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border/60 bg-card hover:bg-secondary',
                    )}
                  >
                    <div className="truncate font-mono text-sm text-foreground">
                      {w.workspaceName}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {workspaceMeta(w)}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </aside>
          <main className="flex min-h-0 min-w-0 flex-col">
            <label
              className="border-b border-border/50 px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground"
              htmlFor="new-session-cwd"
            >
              {t('dialogs.newSessionInitialDirectory')}
            </label>
            <DirectoryPicker
              socket={socket}
              workspaceId={workspaceId}
              initialPath={initialPath}
              value={cwd}
              onChange={setCwd}
              inputId="new-session-cwd"
              inputTestId="new-session-cwd-input"
            />
          </main>
        </div>
        {error ? (
          <div
            className="border-t border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
            data-testid="new-session-error"
          >
            {error}
          </div>
        ) : null}
        <DialogFooter className="border-t border-border/50 px-3 py-2 sm:px-4 sm:py-3">
          <Button variant="outline" onClick={onCancel} disabled={submitting} data-testid="workspace-picker-cancel">
            {t('common.cancel')}
          </Button>
          <Button
            onClick={create}
            disabled={submitting || !selectedWorkspace || cwd.trim().length === 0}
            data-testid="new-session-create"
          >
            {submitting ? t('dialogs.newSessionCreating') : t('dialogs.newWorkspaceSessionCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const WorkspacePicker = NewSessionDialog

function initialPathFor(workspace: AttachedExecutor): string {
  return workspace.sandboxRoots?.[0] ?? workspace.defaultCwd ?? workspace.workingDir ?? '/'
}

function workspaceMeta(workspace: AttachedExecutor): string {
  return [workspace.os, workspace.runtime, workspace.runtimeVersion]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join(' · ')
}
