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

import type { AgentState } from '@agent-kernel/kernel'
import type { ApprovalMode } from '@agent-kernel/kernel'
import type { SessionSummary, ToolCardMode } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
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
  selectedModel: string | null
  executorHost?: string
  onRename(label: string): void
  onOpenChangeCwdDialog(): void
  onChangeApprovalMode(mode: ApprovalMode): void
  onChangeToolCardMode(mode: ToolCardMode): void
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
  selectedModel,
  executorHost,
  onRename,
  onOpenChangeCwdDialog,
  onChangeApprovalMode,
  onChangeToolCardMode,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const initialLabel = summary?.label ?? ''
  const initialCwd = state?.cwd ?? summary?.currentCwd ?? ''
  const approvalMode = state?.approvalMode ?? 'auto'
  const toolCardMode = summary?.preferences?.toolCardMode ?? 'dots'

  const [labelDraft, setLabelDraft] = useState(initialLabel)
  const [approvalDraft, setApprovalDraft] = useState<ApprovalMode>(approvalMode)
  const [toolCardModeDraft, setToolCardModeDraft] = useState<ToolCardMode>(toolCardMode)

  useEffect(() => {
    if (open) {
      setLabelDraft(initialLabel)
      setApprovalDraft(approvalMode)
      setToolCardModeDraft(toolCardMode)
    }
  }, [open, initialLabel, approvalMode, toolCardMode])

  const labelChanged = labelDraft.trim() !== (summary?.label ?? '').trim()
  const approvalChanged = approvalDraft !== approvalMode
  const toolCardModeChanged = toolCardModeDraft !== toolCardMode
  const canSave = labelChanged || approvalChanged || toolCardModeChanged

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
        className="max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{t('dialogs.sessionInfo')}</DialogTitle>
          <DialogDescription>
            {t('dialogs.sessionInfoDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-sm">
          <ReadOnlyRow label={t('dialogs.sessionId')} value={sessionId} mono />
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
          {state?.usage ? (
            <ReadOnlyRow
              label={t('dialogs.tokensInOut')}
              value={`${state.usage.inputTokens.toLocaleString()} / ${state.usage.outputTokens.toLocaleString()}`}
            />
          ) : null}
          <ReadOnlyRow label={t('dialogs.sessionCost')} value="—" />
        </div>

        <div className="border-t border-border/50 pt-3" />

        <div className="grid gap-4 text-sm">
          <FieldRow label={t('dialogs.label')} htmlFor="session-metadata-label">
            <Input
              id="session-metadata-label"
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
            >
              <SelectTrigger data-testid="session-metadata-approval">
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
              <SelectTrigger data-testid="session-metadata-tool-card-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dots">{t('dialogs.toolCardModes.dots')}</SelectItem>
                <SelectItem value="standard">{t('dialogs.toolCardModes.standard')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </div>

        <DialogFooter>
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
}: {
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
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
