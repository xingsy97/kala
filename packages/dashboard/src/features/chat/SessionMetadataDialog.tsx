/**
 * Read-only + editable "session info" modal opened from the workbench toolbar.
 *
 * Read-only rows show what the operator can't change (sessionId, parent,
 * timestamps, workspace, executor, activity counters). Label and approval
 * mode are draft edits committed by the Save button. CWD still opens the
 * dedicated directory picker because it has its own validation flow.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../components/ui/help-hint.js'
import { Link2, RefreshCw, X } from 'lucide-react'
import type { Socket } from 'socket.io-client'

import type { AgentState } from '@agent-kernel/kernel'
import type { ApprovalMode } from '@agent-kernel/kernel'
import type {
  ContextUsageSnapshot,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  SessionStorageSnapshot,
  StorageCleanupPlanPreview,
  SessionSummary,
  ToolCardMode,
} from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
  dialogTouchCloseClassName,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import { saveFile } from '../../lib/save-file.js'
import { getDesktopBridge, validDesktopSessionId } from '../../lib/desktop-bridge.js'
import { writeTextToClipboard } from '../../lib/clipboard.js'
import { notify } from '../../notify.js'
import { evaluationReferenceUrl, explicitEvaluationReference, governedSessionTaskCandidate } from '../../evaluation-integration.js'
import { Input } from '../../components/ui/input.js'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js'

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  sessionId: string
  summary?: SessionSummary
  state: AgentState | null
  contextSnapshot?: ContextUsageSnapshot | null
  selectedModel: string | null
  executorHost?: string
  evaluationUrl?: string
  onRename(label: string): void
  onOpenChangeCwdDialog(): void
  onChangeApprovalMode(mode: ApprovalMode): void
  onChangeToolCardMode(mode: ToolCardMode): void
  canChangeCwd?: boolean
  canChangeApprovalMode?: boolean
  storageSocket?: Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
}

const APPROVAL_MODE_ITEMS: ReadonlyArray<{ value: ApprovalMode; labelKey: string }> = [
  { value: 'auto', labelKey: 'dialogs.approvalModes.auto' },
  { value: 'ask', labelKey: 'dialogs.approvalModes.ask' },
  { value: 'deny', labelKey: 'dialogs.approvalModes.deny' },
  { value: 'allow_all', labelKey: 'dialogs.approvalModes.allowAll' },
]

export function SessionMetadataDialog({
  open,
  onOpenChange,
  sessionId,
  summary,
  state,
  contextSnapshot,
  selectedModel,
  executorHost,
  evaluationUrl,
  onRename,
  onOpenChangeCwdDialog,
  onChangeApprovalMode,
  onChangeToolCardMode,
  canChangeCwd = true,
  canChangeApprovalMode = true,
  storageSocket,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const initialLabel = summary?.label ?? ''
  const initialCwd = state?.cwd ?? summary?.currentCwd ?? ''
  const approvalMode = state?.approvalMode ?? 'auto'
  const toolCardMode = summary?.preferences?.toolCardMode ?? 'dots'
  const agentRuntime = summary?.agentRuntime ?? 'kernel'
  const agentRuntimeLabel = agentRuntime === 'copilot'
    ? 'GitHub Copilot SDK'
    : 'Agent Kernel'
  const agentRuntimeDisplay = `${agentRuntimeLabel} (${agentRuntime})${summary?.agentRuntimeVersion ? ` · v${summary.agentRuntimeVersion}` : ''}`
  const directContextTokens = contextSnapshot?.usage.totalTokens
  const directInputTokens = state?.usage.inputTokens
  const directOutputTokens = state?.usage.outputTokens

  const [labelDraft, setLabelDraft] = useState(initialLabel)
  const [approvalDraft, setApprovalDraft] = useState<ApprovalMode>(approvalMode)
  const [toolCardModeDraft, setToolCardModeDraft] = useState<ToolCardMode>(toolCardMode)
  const [storage, setStorage] = useState<SessionStorageSnapshot | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [cleanupPlan, setCleanupPlan] = useState<StorageCleanupPlanPreview | null>(null)
  const [cleanupConfirmationStep, setCleanupConfirmationStep] = useState<'review' | 'final'>('review')
  const [cleanupBusy, setCleanupBusy] = useState(false)

  const loadStorage = (refresh: boolean): void => {
    if (!storageSocket || !sessionId) return
    setStorageLoading(true)
    setStorageError(null)
    storageSocket.emit('client:get_session_storage', { sessionId, ...(refresh ? { refresh: true } : {}) }, (result) => {
      setStorageLoading(false)
      if (result.ok) setStorage(result.value)
      else setStorageError(result.error)
    })
  }

  const prepareSubagentCleanup = (targetId: string): void => {
    if (!storageSocket) return
    setCleanupBusy(true)
    setStorageError(null)
    storageSocket.emit('client:prepare_storage_cleanup', { operation: 'subagent-details', targetId }, (result) => {
      setCleanupBusy(false)
      if (result.ok) {
        setCleanupPlan(result.value)
        setCleanupConfirmationStep('review')
      }
      else setStorageError(result.error)
    })
  }

  const executeCleanup = (): void => {
    if (!storageSocket || !cleanupPlan) return
    setCleanupBusy(true)
    setStorageError(null)
    storageSocket.emit('client:execute_storage_cleanup', { planId: cleanupPlan.planId }, (result) => {
      setCleanupBusy(false)
      if (!result.ok) {
        setStorageError(result.error)
        return
      }
      setCleanupPlan(null)
      setCleanupConfirmationStep('review')
      loadStorage(true)
    })
  }

  useEffect(() => {
    if (open) {
      setLabelDraft(initialLabel)
      setApprovalDraft(approvalMode)
      setToolCardModeDraft(toolCardMode)
      loadStorage(false)
    }
  }, [open, initialLabel, approvalMode, toolCardMode, sessionId, storageSocket])

  const labelChanged = labelDraft.trim() !== (summary?.label ?? '').trim()
  const approvalChanged = approvalDraft !== approvalMode
  const toolCardModeChanged = toolCardModeDraft !== toolCardMode
  const canSave = labelChanged || approvalChanged || toolCardModeChanged
  const evaluationReference = typeof window === 'undefined' ? undefined : explicitEvaluationReference(window.location, sessionId)
  const desktopSessionLink = getDesktopBridge() && validDesktopSessionId(sessionId) ? `agent-runlab://session/${sessionId}` : null
  const copyDesktopSessionLink = async (): Promise<void> => {
    if (!desktopSessionLink) return
    try {
      await writeTextToClipboard(desktopSessionLink)
      notify.success(t('common.copied'), { id: 'desktop-session-link' })
    } catch (error) {
      notify.error(t('desktopNative.copyLinkFailed'), {
        id: 'desktop-session-link',
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const exportTaskCandidate = async (): Promise<void> => {
    const candidate = governedSessionTaskCandidate(sessionId, summary, selectedModel)
    await saveFile({ suggestedName: 'agent-eval-task-candidate-' + sessionId.replace(/[^A-Za-z0-9._:-]/gu, '-') + '.json', blob: new Blob([JSON.stringify(candidate, null, 2) + '\n'], { type: 'application/json' }), mimeType: 'application/json' })
  }

  const save = (): void => {
    const nextLabel = labelDraft.trim()
    if (labelChanged) onRename(nextLabel)
    if (approvalChanged) onChangeApprovalMode(approvalDraft)
    if (toolCardModeChanged) onChangeToolCardMode(toolCardModeDraft)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="session-metadata-dialog"
        className={cn(dialogMobileSheetClassName, 'grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl')}
      >
        <DialogHeader className="relative border-b border-border/60 px-4 py-3 pr-14 sm:px-6 sm:py-4 sm:pr-14">
          <DialogTitle className="flex items-center gap-1 text-lg">{t('dialogs.sessionInfo')}<HelpHint label={t('dialogs.sessionInfo')}>{t('dialogs.sessionInfoDescription')}</HelpHint></DialogTitle>
          <DialogDescription className="sr-only">{t('common.contextualHelp')}</DialogDescription>
          <DialogClose className={dialogTouchCloseClassName} aria-label={t('common.close')}>
            <X className="h-5 w-5" aria-hidden="true" />
          </DialogClose>
        </DialogHeader>

        <DialogBody className="px-4 py-4 sm:px-6" data-testid="session-metadata-body">
        <div className="grid gap-3 text-sm">
          <ReadOnlyRow label={t('dialogs.sessionId')} value={sessionId} mono action={desktopSessionLink ? (
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" data-testid="copy-desktop-session-link" aria-label={t('desktopNative.copySessionLink')} title={t('desktopNative.copySessionLink')} onClick={() => void copyDesktopSessionLink()}>
              <Link2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null} />
          <ReadOnlyRow
            label={t('dialogs.agentRuntime')}
            value={agentRuntimeDisplay}
            testId="session-metadata-agent-runtime"
          />
          {summary?.parentSessionId ? (
            <ReadOnlyRow
              label={t('dialogs.parentSession')}
              value={summary.parentSessionId}
              mono
            />
          ) : null}
          <ReadOnlyRow label={t('dialogs.created')} value={formatTs(summary?.createdAt)} />
          <ReadOnlyRow
            label={t('dialogs.lastActivity')}
            value={formatTs(summary?.lastEventAt ?? summary?.createdAt)}
          />
          <ReadOnlyRow
            label={t('dialogs.workspace')}
            value={
              summary?.workspaceName
                ? `${summary.workspaceName}${summary.workspaceId ? ` · ${summary.workspaceId.slice(0, 8)}` : ''}`
                : summary?.workspaceId ?? t('dialogs.unassigned')
            }
          />
          {executorHost ? (
            <ReadOnlyRow label={t('dialogs.executorHost')} value={executorHost} />
          ) : null}
          <ReadOnlyRow
            label={t('common.model')}
            value={selectedModel ?? t('dialogs.defaultModel')}
            mono
          />
          <ReadOnlyRow
            label={t('dialogs.events')}
            value={String(summary?.eventCount ?? state?.messages.length ?? 0)}
          />
          {storage?.tokenUsage ? (
            <>
              <ReadOnlyRow
                label="Context tokens (tree / direct)"
                value={`${storage.tokenUsage.tree.currentContextTokens.toLocaleString()} / ${storage.tokenUsage.direct.currentContextTokens.toLocaleString()}`}
              />
              <ReadOnlyRow
                label={`${t('dialogs.tokensInOut')} (tree)`}
                value={`${storage.tokenUsage.tree.cumulativeInputTokens.toLocaleString()} / ${storage.tokenUsage.tree.cumulativeOutputTokens.toLocaleString()}`}
              />
              <ReadOnlyRow
                label={`${t('dialogs.tokensInOut')} (direct)`}
                value={`${storage.tokenUsage.direct.cumulativeInputTokens.toLocaleString()} / ${storage.tokenUsage.direct.cumulativeOutputTokens.toLocaleString()}`}
              />
            </>
          ) : (
            <>
              {directContextTokens !== undefined ? (
                <ReadOnlyRow
                  label="Context tokens (direct)"
                  value={directContextTokens.toLocaleString()}
                />
              ) : null}
              {directInputTokens !== undefined || directOutputTokens !== undefined ? (
                <ReadOnlyRow
                  label={`${t('dialogs.tokensInOut')} (direct)`}
                  value={`${(directInputTokens ?? 0).toLocaleString()} / ${(directOutputTokens ?? 0).toLocaleString()}`}
                />
              ) : null}
            </>
          )}
          <ReadOnlyRow label={t('dialogs.sessionCost')} value="—" />
        </div>

        <div className="border-t border-border/50 pt-3" />

        <section className="grid gap-2 text-sm" aria-label="Storage" data-testid="session-storage">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Storage</span>
            <Button type="button" variant="ghost" size="sm" disabled={storageLoading || !storageSocket} onClick={() => loadStorage(true)}>
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', storageLoading && 'animate-spin')} aria-hidden />
              Refresh
            </Button>
          </div>
          {storageError ? <p className="text-xs text-destructive">{storageError}</p> : storage ? (
            <>
              <div className="grid grid-cols-2 gap-2 rounded-md border border-border/50 bg-muted/20 p-3">
                <StorageMetric label="This session" bytes={storage.session.directBytes} />
                <StorageMetric label={`Tree (${storage.session.descendantCount} sub-agents)`} bytes={storage.session.treeBytes} />
              </div>
              {storage.descendants.length > 0 ? (
                <div className="divide-y divide-border/40 rounded-md border border-border/50">
                  {storage.descendants.map((entry) => (
                    <div key={entry.sessionId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs" title={entry.sessionId}>{entry.sessionId}</div>
                        <div className="text-caption text-muted-foreground">
                          {formatBytes(entry.directBytes)} direct · {formatBytes(entry.treeBytes)} subtree
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={cleanupBusy}
                        onClick={() => prepareSubagentCleanup(entry.sessionId)}
                      >
                        Delete details…
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              {cleanupPlan ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3" data-testid="storage-cleanup-confirmation">
                  <div className="font-medium">
                    {cleanupConfirmationStep === 'review' ? 'Review sub-agent cleanup' : 'Final confirmation required'}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    This moves {cleanupPlan.itemCount} exact files ({formatBytes(cleanupPlan.estimatedBytes)}) out of the active session store.
                    The graph result and a tombstone remain. The operation is revalidated before any file is moved.
                  </p>
                  {cleanupConfirmationStep === 'final' ? (
                    <p className="mt-2 font-medium text-destructive">
                      Confirm again to quarantine these details. This is the second and final confirmation.
                    </p>
                  ) : null}
                  <div className="mt-3 flex gap-2">
                    {cleanupConfirmationStep === 'review' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={cleanupBusy}
                        data-testid="storage-cleanup-first-confirm"
                        onClick={() => setCleanupConfirmationStep('final')}
                      >
                        Continue
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={cleanupBusy}
                        data-testid="storage-cleanup-final-confirm"
                        onClick={executeCleanup}
                      >
                        Confirm quarantine
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="outline" disabled={cleanupBusy} onClick={() => {
                      setCleanupPlan(null)
                      setCleanupConfirmationStep('review')
                    }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
              <p className="text-caption text-muted-foreground">
                Measured {storage.state.measuredAt ? formatTs(storage.state.measuredAt) : 'not yet'}; refresh performs a background metadata scan.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{storageLoading ? 'Measuring storage…' : 'Storage has not been measured yet.'}</p>
          )}
        </section>

        <div className="border-t border-border/50 pt-3" />

        <section className="grid gap-2 text-sm" aria-label={t('sessionMetadata.evaluation')}>
          <span className="text-xs uppercase tracking-wider text-muted-foreground">{t('sessionMetadata.evaluation')}</span>
          <p className="text-xs text-muted-foreground">{t('sessionMetadata.evaluationDescription')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" data-testid="session-export-task-candidate" onClick={() => void exportTaskCandidate()}>{t('sessionMetadata.exportCandidate')}</Button>
            {evaluationReference && evaluationUrl ? <Button type="button" variant="outline" size="sm" asChild><a data-testid="session-open-evaluation-reference" href={evaluationReferenceUrl(evaluationReference, evaluationUrl)} target="_blank" rel="noreferrer">{t('sessionMetadata.openEvidence')}</a></Button> : null}
          </div>
        </section>

        <div className="border-t border-border/50 pt-3" />

        <div className="grid gap-4 text-sm">
          <FieldRow label={t('dialogs.label')} htmlFor="session-metadata-label">
            <Input
              id="session-metadata-label"
              className="text-base sm:text-sm"
              data-testid="session-metadata-label"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (canSave) save()
                }
              }}
              placeholder={t('dialogs.clearOverridePlaceholder')}
            />
          </FieldRow>
          <FieldRow label={t('dialogs.workingDirectory')} htmlFor="session-metadata-cwd">
            <div className="flex items-center gap-2">
              <div
                id="session-metadata-cwd"
                data-testid="session-metadata-cwd"
                className="min-w-0 flex-1 truncate rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-xs text-foreground"
                title={initialCwd || t('dialogs.noCwdSet')}
              >
                {initialCwd || (
                  <span className="text-muted-foreground">{t('dialogs.noCwdSet')}</span>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false)
                  onOpenChangeCwdDialog()
                }}
                disabled={!canChangeCwd}
                data-testid="session-metadata-cwd-change"
              >
                {t('dialogs.change')}
              </Button>
            </div>
          </FieldRow>
          <FieldRow label={t('dialogs.approvals')}>
            <Select
              value={approvalDraft}
              onValueChange={(v) => setApprovalDraft(v as ApprovalMode)}
              disabled={!canChangeApprovalMode}
            >
              <SelectTrigger className="h-11 text-base sm:h-8 sm:text-sm" data-testid="session-metadata-approval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPROVAL_MODE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label={t('dialogs.toolCardMode')}>
            <Select value={toolCardModeDraft} onValueChange={(value) => setToolCardModeDraft(value as ToolCardMode)}>
              <SelectTrigger className="h-11 text-base sm:h-8 sm:text-sm" data-testid="session-metadata-tool-card-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dots">{t('dialogs.toolCardModes.dots')}</SelectItem>
                <SelectItem value="standard">{t('dialogs.toolCardModes.standard')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </div>

        </DialogBody>

        <DialogFooter className="border-t border-border/60 bg-card px-4 py-3 sm:px-6" data-testid="session-metadata-footer">
          <Button
            type="button"
            onClick={save}
            disabled={!canSave}
            data-testid="session-metadata-save"
          >
            {t('common.save')}
          </Button>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t('common.close')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReadOnlyRow({
  label,
  value,
  mono = false,
  testId,
  action,
}: {
  label: string
  value: string
  mono?: boolean
  testId?: string
  action?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground">
        {label}
        {action}
      </span>
      <span
        data-testid={testId}
        className={
          mono
            ? 'font-mono text-xs text-foreground truncate max-w-[65%]'
            : 'text-foreground truncate max-w-[65%]'
        }
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function FieldRow({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-xs uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

function formatTs(iso: string | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function StorageMetric({ label, bytes }: { label: string; bytes: number }): JSX.Element {
  return <div><div className="text-caption text-muted-foreground">{label}</div><div className="font-medium">{formatBytes(bytes)}</div></div>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0]!
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]!
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`
}
