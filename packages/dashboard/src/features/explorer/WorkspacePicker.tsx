/**
 * Modal for choosing which workspace a new session should be bound to.
 *
 * Only shown when there are  - 2 online workspaces. With 0 or 1, `app.tsx`
 * short-circuits (falls back to Unassigned or auto-binds to the sole
 * workspace).
 *
 * Kept intentionally small: one row per online workspace, click to pick.
 * No search/keyboard nav yet  -  the day-to-day case is 1 or 2 machines.
 */

import { useEffect, useRef } from 'react'
import type { AttachedExecutor } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'

type Props = {
  open: boolean
  workspaces: readonly AttachedExecutor[]
  onPick(workspaceId: string, workspaceName: string | undefined): void
  onCancel(): void
}

export function WorkspacePicker({
  open,
  workspaces,
  onPick,
  onCancel,
}: Props): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onCancel}
      data-testid="workspace-picker-overlay"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-label="pick workspace for new session"
        data-testid="workspace-picker"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl outline-none dark:border-slate-800 dark:bg-slate-950"
      >
        <div className="mb-3">
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Pick a workspace
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-400">
            The new session will run its tool calls on the machine you choose.
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          {workspaces.map((w) => (
            <button
              key={w.workspaceId}
              type="button"
              data-testid={`workspace-pick-${w.workspaceId}`}
              onClick={() => onPick(w.workspaceId, w.workspaceName)}
              className="flex flex-col items-start rounded-md border border-slate-200 px-3 py-2 text-left hover:border-sky-400 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-sky-500 dark:hover:bg-slate-900"
            >
              <span className="font-mono text-sm text-slate-900 dark:text-slate-100">
                {w.workspaceName}
              </span>
              <span className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-500">
                {[w.os, w.runtime, w.runtimeVersion, w.ipAddresses?.[0]]
                  .filter((s) => typeof s === 'string' && s.length > 0)
                  .join('  -  ')}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            data-testid="workspace-picker-cancel"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
