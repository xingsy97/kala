/**
 * Read-only + editable "session info" modal opened from the workbench toolbar.
 *
 * Read-only rows show what the operator can't change (sessionId, parent,
 * timestamps, workspace, executor, activity counters). The three editable
 * rows (label / cwd / approvalMode) each fire their own protocol event on
 * blur or submit so the modal can stay open while the host echoes the
 * result back through `session:renamed`, `event:appended` (cwd_changed),
 * or `session:approval_mode`.
 */

import { useEffect, useState } from 'react'

import type { AgentState } from '@agent-kernel/kernel'
import type { ApprovalMode } from '@agent-kernel/kernel'
import type { SessionSummary } from '@agent-kernel/shared'

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
  onChangeCwd(cwd: string): void
  onChangeApprovalMode(mode: ApprovalMode): void
}

const APPROVAL_MODE_ITEMS: ReadonlyArray<{ value: ApprovalMode; label: string }> = [
  { value: 'auto', label: 'Auto (ask on unsafe tools)' },
  { value: 'ask', label: 'Ask everything' },
  { value: 'deny', label: 'Deny unsafe' },
  { value: 'allow_all', label: 'Allow all (danger)' },
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
  onChangeCwd,
  onChangeApprovalMode,
}: Props): JSX.Element {
  const initialLabel = summary?.label ?? ''
  const initialCwd = state?.cwd ?? summary?.currentCwd ?? ''
  const approvalMode = state?.approvalMode ?? 'auto'

  const [labelDraft, setLabelDraft] = useState(initialLabel)
  const [cwdDraft, setCwdDraft] = useState(initialCwd)

  useEffect(() => {
    if (open) {
      setLabelDraft(initialLabel)
      setCwdDraft(initialCwd)
    }
  }, [open, initialLabel, initialCwd])

  const commitLabel = (): void => {
    const next = labelDraft.trim()
    if (next === (summary?.label ?? '').trim()) return
    onRename(next)
  }
  const commitCwd = (): void => {
    const next = cwdDraft.trim()
    if (next.length === 0) return
    if (next === (state?.cwd ?? '').trim()) return
    onChangeCwd(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="session-metadata-dialog"
        className="max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>Session info</DialogTitle>
          <DialogDescription>
            Read-only identifiers on the left, live-editable settings below. Changes save on blur.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-sm">
          <ReadOnlyRow label="Session ID" value={sessionId} mono />
          {summary?.parentSessionId ? (
            <ReadOnlyRow
              label="Parent session"
              value={summary.parentSessionId}
              mono
            />
          ) : null}
          <ReadOnlyRow label="Created" value={formatTs(summary?.createdAt)} />
          <ReadOnlyRow
            label="Last activity"
            value={formatTs(summary?.lastEventAt ?? summary?.createdAt)}
          />
          <ReadOnlyRow
            label="Workspace"
            value={
              summary?.workspaceName
                ? `${summary.workspaceName}${summary.workspaceId ? ` · ${summary.workspaceId.slice(0, 8)}` : ''}`
                : summary?.workspaceId ?? 'unassigned'
            }
          />
          {executorHost ? (
            <ReadOnlyRow label="Executor host" value={executorHost} />
          ) : null}
          <ReadOnlyRow
            label="Model"
            value={selectedModel ?? 'default'}
            mono
          />
          <ReadOnlyRow
            label="Events"
            value={String(summary?.eventCount ?? state?.messages.length ?? 0)}
          />
          {state?.usage ? (
            <ReadOnlyRow
              label="Tokens (in / out / cost)"
              value={`${state.usage.inputTokens.toLocaleString()} / ${state.usage.outputTokens.toLocaleString()} / $${state.usage.costUsd.toFixed(4)}`}
            />
          ) : null}
        </div>

        <div className="border-t pt-3" />

        <div className="grid gap-4 text-sm">
          <FieldRow label="Label" htmlFor="session-metadata-label">
            <Input
              id="session-metadata-label"
              data-testid="session-metadata-label"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.currentTarget as HTMLInputElement).blur()
                }
              }}
              placeholder="clears override when empty"
            />
          </FieldRow>
          <FieldRow label="Working directory" htmlFor="session-metadata-cwd">
            <Input
              id="session-metadata-cwd"
              data-testid="session-metadata-cwd"
              value={cwdDraft}
              onChange={(e) => setCwdDraft(e.target.value)}
              onBlur={commitCwd}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.currentTarget as HTMLInputElement).blur()
                }
              }}
              placeholder="/absolute/path"
              className="font-mono"
            />
          </FieldRow>
          <FieldRow label="Approvals">
            <Select
              value={approvalMode}
              onValueChange={(v) => onChangeApprovalMode(v as ApprovalMode)}
            >
              <SelectTrigger data-testid="session-metadata-approval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPROVAL_MODE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Close
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
