import { useEffect, useMemo, useState } from 'react'
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
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { cn } from '../../lib/utils.js'
import type { DashboardSocket } from '../../session.js'
import { DirectoryPicker } from './DirectoryPicker.js'

type Props = {
  open: boolean
  workspaces: readonly AttachedExecutor[]
  initialWorkspaceId?: string
  socket: DashboardSocket | null
  onCreate(input: {
    workspaceId: string
    workspaceName: string | undefined
    cwd: string
  }): void
  onCancel(): void
}

export function NewSessionDialog({
  open,
  workspaces,
  initialWorkspaceId,
  socket,
  onCreate,
  onCancel,
}: Props): JSX.Element {
  const [workspaceId, setWorkspaceId] = useState('')
  const [cwd, setCwd] = useState('')
  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.workspaceId === workspaceId),
    [workspaceId, workspaces],
  )

  useEffect(() => {
    if (!open) return
    const first =
      workspaces.find((w) => w.workspaceId === initialWorkspaceId) ?? workspaces[0]
    setWorkspaceId(first?.workspaceId ?? '')
    setCwd(first ? initialPathFor(first) : '')
  }, [initialWorkspaceId, open, workspaces])

  const selectWorkspace = (id: string): void => {
    const workspace = workspaces.find((w) => w.workspaceId === id)
    setWorkspaceId(id)
    setCwd(workspace ? initialPathFor(workspace) : '')
  }

  const create = (): void => {
    if (!selectedWorkspace || cwd.trim().length === 0) return
    onCreate({
      workspaceId: selectedWorkspace.workspaceId,
      workspaceName: selectedWorkspace.workspaceName,
      cwd: cwd.trim(),
    })
  }

  const initialPath = selectedWorkspace ? initialPathFor(selectedWorkspace) : undefined

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent className="max-w-4xl h-[78vh] overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)_auto]" data-testid="new-session-dialog">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Choose the workspace and initial directory for tool calls.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)]">
          <aside className="min-h-0 border-r border-border/50 bg-muted">
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground">Workspaces</div>
            <ScrollArea className="h-[calc(78vh-9.5rem)]">
              <div className="space-y-1 px-2 pb-2">
                {workspaces.length === 0 ? (
                  <div className="rounded border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                    No executor is online.
                  </div>
                ) : null}
                {workspaces.map((w) => (
                  <button
                    key={w.workspaceId}
                    type="button"
                    data-testid={`workspace-pick-${w.workspaceId}`}
                    onClick={() => selectWorkspace(w.workspaceId)}
                    className={cn(
                      'w-full rounded-md border px-2 py-2 text-left transition-colors',
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
              Initial directory
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
        <DialogFooter className="border-t border-border/50 px-4 py-3">
          <Button variant="outline" onClick={onCancel} data-testid="workspace-picker-cancel">
            Cancel
          </Button>
          <Button
            onClick={create}
            disabled={!selectedWorkspace || cwd.trim().length === 0}
            data-testid="new-session-create"
          >
            Create session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const WorkspacePicker = NewSessionDialog

function initialPathFor(workspace: AttachedExecutor): string {
  return workspace.sandboxRoots?.[0] ?? workspace.workingDir ?? '/'
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
