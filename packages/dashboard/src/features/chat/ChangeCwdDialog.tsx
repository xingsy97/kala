import { useEffect, useState } from 'react'
import type { AttachedExecutor } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { DirectoryPicker } from '../explorer/DirectoryPicker.js'
import type { DashboardSocket } from '../../session.js'

type Props = {
  open: boolean
  socket: DashboardSocket | null
  workspace: AttachedExecutor | undefined
  currentCwd: string
  onSave(cwd: string): void
  onOpenChange(open: boolean): void
}

export function ChangeCwdDialog({
  open,
  socket,
  workspace,
  currentCwd,
  onSave,
  onOpenChange,
}: Props): JSX.Element {
  const [cwd, setCwd] = useState(currentCwd)

  useEffect(() => {
    if (open) setCwd(currentCwd)
  }, [open, currentCwd])

  const trimmed = cwd.trim()
  const dirty = trimmed.length > 0 && trimmed !== currentCwd.trim()

  const submit = (): void => {
    if (!dirty) return
    onSave(trimmed)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl h-[78vh] overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)_auto]"
        data-testid="change-cwd-dialog"
      >
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle>Change session cwd</DialogTitle>
          <DialogDescription>
            Tool calls for this session will run from the selected directory after the host accepts it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)]">
          <aside className="min-h-0 border-r border-border/50 bg-muted">
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground">Workspace</div>
            <div className="px-2 pb-2">
              {workspace ? (
                <div
                  className="w-full rounded-md border border-primary bg-primary/10 px-2 py-2 text-left"
                  data-testid="change-cwd-workspace"
                >
                  <div className="truncate font-mono text-sm text-foreground">
                    {workspace.workspaceName ?? workspace.workspaceId}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {workspaceMeta(workspace)}
                  </div>
                </div>
              ) : (
                <div className="rounded border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                  Workspace offline — start its executor to browse directories.
                </div>
              )}
              <p className="mt-3 px-1 text-[11px] text-muted-foreground">
                A session stays in its workspace. To use another workspace, start a new session.
              </p>
            </div>
          </aside>
          <main className="flex min-h-0 min-w-0 flex-col">
            <label
              className="border-b border-border/50 px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground"
              htmlFor="change-cwd-input"
            >
              Working directory
            </label>
            <DirectoryPicker
              socket={socket}
              workspaceId={workspace?.workspaceId ?? ''}
              initialPath={currentCwd || workspace?.sandboxRoots?.[0] || workspace?.workingDir}
              value={cwd}
              onChange={setCwd}
              inputId="change-cwd-input"
              inputTestId="cwd-input"
            />
          </main>
        </div>
        <DialogFooter className="border-t border-border/50 px-4 py-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="change-cwd-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!dirty}
            data-testid="cwd-save-button"
          >
            Save cwd
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function workspaceMeta(workspace: AttachedExecutor): string {
  return [
    workspace.os,
    workspace.runtime,
    workspace.runtimeVersion,
    workspace.sandboxRoots?.[0] ?? workspace.workingDir,
  ]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join(' · ')
}
