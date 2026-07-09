/**
 * Read-only "workspace info" modal opened from the Explorer.
 *
 * All fields are derived from the executor's announce payload plus a count
 * of sessions bound to this workspace. No user-editable fields — workspace
 * identity is set once at executor launch and never renamed here.
 */

import type { AttachedExecutor, SessionSummary } from '@agent-kernel/shared'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  workspaceId: string
  workspaceName?: string
  executor?: AttachedExecutor
  sessions: readonly SessionSummary[]
}

export function WorkspaceMetadataDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  executor,
  sessions,
}: Props): JSX.Element {
  const rows: Array<[string, string]> = [
    ['Workspace id', workspaceId],
    ['Workspace name', workspaceName ?? executor?.workspaceName ?? '—'],
    ['Runtime', executor ? `${executor.runtime} ${executor.runtimeVersion}` : '—'],
    ['OS', executor?.os ?? '—'],
    ['Hostname', executor?.hostname ?? '—'],
    ['Working dir', executor?.workingDir ?? '—'],
    [
      'Sandbox roots',
      executor?.sandboxRoots && executor.sandboxRoots.length > 0
        ? executor.sandboxRoots.join(', ')
        : 'trusts whole machine',
    ],
    ['Executor id', executor?.executorId ?? 'not attached'],
    [
      'Started at',
      executor?.startedAt ? new Date(executor.startedAt).toLocaleString() : '—',
    ],
    ['PID', executor?.pid ? String(executor.pid) : '—'],
    ['Sessions in workspace', String(sessions.length)],
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] max-w-2xl overflow-hidden p-0 gap-0"
        data-testid="workspace-metadata-dialog"
      >
        <DialogHeader className="border-b border-border/50 px-5 py-4">
          <DialogTitle>{workspaceName ?? executor?.workspaceName ?? 'Workspace'}</DialogTitle>
          <DialogDescription>
            Identity announced by the executor. Read-only — restart the executor to change these values.
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 py-4">
          <div className="overflow-hidden rounded-md border border-border/50">
            <table className="w-full text-sm">
              <tbody>
                {rows.map(([label, value], i) => (
                  <tr
                    key={label}
                    className={i !== rows.length - 1 ? 'border-b border-border/50' : ''}
                  >
                    <th className="w-44 border-r border-border/50 bg-muted/50 px-3 py-2 text-left font-medium">
                      {label}
                    </th>
                    <td className="px-3 py-2 font-mono text-xs break-all">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
