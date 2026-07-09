import { useEffect, useState, type FormEvent } from 'react'
import { Pencil, ShieldCheck, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { AttachedExecutor, ExecutorIdentitySummary, ServerExecutorIdentitiesPayload, ServerSettingsPayload, SessionSummary } from '@agent-kernel/shared'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js'
import { Button } from '../../components/ui/button.js'

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  workspaceId: string
  workspaceName?: string
  executor?: AttachedExecutor
  sessions: readonly SessionSummary[]
  onRename?(workspaceName: string): void
}

export function WorkspaceMetadataDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  executor,
  sessions,
  onRename,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const displayName = workspaceName ?? executor?.workspaceName ?? ''
  const [draft, setDraft] = useState(displayName)
  useEffect(() => {
    if (open) setDraft(displayName)
  }, [displayName, open])

  const identitiesQuery = useQuery({
    queryKey: ['executor-identities'],
    queryFn: async (): Promise<ServerExecutorIdentitiesPayload> => {
      const res = await fetch('/auth/executor-identities', { cache: 'no-store' })
      if (!res.ok) throw new Error(await res.text())
      return (await res.json()) as ServerExecutorIdentitiesPayload
    },
    enabled: open && workspaceId.length > 0,
    staleTime: 15_000,
  })
  const identity: ExecutorIdentitySummary | null =
    identitiesQuery.data?.identities.find((entry) => entry.workspaceId === workspaceId) ?? null
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: async (): Promise<ServerSettingsPayload> => {
      const res = await fetch('/settings', { cache: 'no-store' })
      if (!res.ok) throw new Error(await res.text())
      return (await res.json()) as ServerSettingsPayload
    },
    enabled: open,
    staleTime: 30_000,
  })

  const revokeMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const params = new URLSearchParams({ workspaceId })
      const res = await fetch(`/auth/executor-identities?${params.toString()}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
    },
    onSuccess: () => {
      queryClient.setQueryData<ServerExecutorIdentitiesPayload>(['executor-identities'], (prev) => {
        if (!prev) return prev
        return { ...prev, identities: prev.identities.filter((entry) => entry.workspaceId !== workspaceId) }
      })
    },
  })
  const revoking = revokeMutation.isPending
  const identityError =
    (revokeMutation.error as Error | undefined)?.message ??
    (identitiesQuery.error as Error | undefined)?.message ??
    null

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const trimmed = draft.trim()
    if (trimmed.length === 0 || trimmed === displayName) return
    onRename?.(trimmed)
  }
  const revokeIdentity = (): void => {
    if (workspaceId.length === 0) return
    revokeMutation.mutate()
  }
  const rows: Array<[string, string]> = [
    [t('workspaceMetadata.workspaceId'), workspaceId],
    [t('workspaceMetadata.hostVersion'), settingsQuery.data?.versions?.host ?? '—'],
    [t('workspaceMetadata.executorVersion'), executor?.executorVersion ?? '—'],
    [t('workspaceMetadata.protocolVersion'), executor?.clientVersion ?? settingsQuery.data?.versions?.protocol ?? '—'],
    [t('workspaceMetadata.runtime'), executor ? `${executor.runtime} ${executor.runtimeVersion}` : '—'],
    [t('workspaceMetadata.os'), executor?.os ?? '—'],
    [t('workspaceMetadata.hostname'), executor?.hostname ?? '—'],
    [
      t('workspaceMetadata.sandboxRoots'),
      executor?.sandboxRoots && executor.sandboxRoots.length > 0
        ? executor.sandboxRoots.join(', ')
        : t('workspaceMetadata.trustsWholeMachine'),
    ],
    [t('workspaceMetadata.executorId'), executor?.executorId ?? t('workspaceMetadata.notAttached')],
    [
      t('workspaceMetadata.startedAt'),
      executor?.startedAt ? new Date(executor.startedAt).toLocaleString() : '—',
    ],
    [t('workspaceMetadata.pid'), executor?.pid ? String(executor.pid) : '—'],
    [t('workspaceMetadata.sessionsInWorkspace'), String(sessions.length)],
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] max-w-2xl overflow-hidden p-0 gap-0"
        data-testid="workspace-metadata-dialog"
      >
        <DialogHeader className="border-b border-border/50 px-5 py-4">
          <DialogTitle>{displayName || t('workspaceMetadata.workspace')}</DialogTitle>
          <DialogDescription>
            {t('workspaceMetadata.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4">
          <form onSubmit={submit} className="rounded-md border border-border/50 bg-card p-3" data-testid="workspace-metadata-rename-form">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="workspace-display-name">
              {t('workspaceMetadata.displayName')}
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="workspace-display-name"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                data-testid="workspace-metadata-name-input"
              />
              <Button type="submit" size="sm" disabled={draft.trim().length === 0 || draft.trim() === displayName} data-testid="workspace-metadata-rename-button">
                <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t('workspaceMetadata.rename')}
              </Button>
            </div>
          </form>
          <section className="rounded-md border border-border/50 bg-card p-3" data-testid="workspace-identity-card">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {identity ? <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden />}
                  {t('workspaceMetadata.executorIdentity')}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {identity
                    ? t('workspaceMetadata.identityBound', { lastSeen: identity.lastSeenAt ? new Date(identity.lastSeenAt).toLocaleString() : t('workspaceMetadata.neverSeen') })
                    : t('workspaceMetadata.identityNotBound')}
                </p>
                {identityError ? <p className="mt-2 text-xs text-destructive">{identityError}</p> : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!identity || revoking}
                onClick={() => revokeIdentity()}
                data-testid="workspace-revoke-identity-button"
              >
                <ShieldOff className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {revoking ? t('workspaceMetadata.revokingIdentity') : t('workspaceMetadata.revokeIdentity')}
              </Button>
            </div>
          </section>
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
