import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
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
        className="h-[min(90dvh,44rem)] max-w-4xl overflow-hidden p-0 gap-0 grid-rows-[auto_minmax(0,1fr)_auto]"
        data-testid="change-cwd-dialog"
      >
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle>{t('dialogs.changeCwd')}</DialogTitle>
          <DialogDescription>
            {t('dialogs.changeCwdDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="min-h-0 border-b border-border/50 bg-muted md:border-b-0 md:border-r">
            <div className="px-3 py-2 text-xs font-medium text-muted-foreground">{t('dialogs.workspace')}</div>
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
                  {t('dialogs.workspaceOfflineBrowse')}
                </div>
              )}
              <p className="mt-3 px-1 text-[11px] text-muted-foreground">
                {t('dialogs.workspaceSticky')}
              </p>
            </div>
          </aside>
          <main className="flex min-h-0 min-w-0 flex-col">
            <label
              className="border-b border-border/50 px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground"
              htmlFor="change-cwd-input"
            >
              {t('dialogs.workingDirectory')}
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
            {t('common.cancel')}
          </Button>
          <Button
            onClick={submit}
            disabled={!dirty}
            data-testid="cwd-save-button"
          >
            {t('dialogs.saveCwd')}
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
