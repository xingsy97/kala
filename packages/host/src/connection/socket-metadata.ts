import type { ExecutorAnnounce } from '@agent-kernel/shared'

import type { DashboardActor } from '../auth-control.js'

export type ConnectionMeta =
  | {
      kind: 'dashboard'
      label: string
      clientVersion: string
      connectedAt: string
    }
  | {
      kind: 'executor'
      label: string
      clientVersion: string
      connectedAt: string
      executorId?: string
      workspaceId?: string
      workspaceName?: string
    }

export function dashboardConnectionMeta(input: {
  actor: DashboardActor
  clientVersion: string
}): ConnectionMeta {
  return {
    kind: 'dashboard',
    label: dashboardLabel(input.actor),
    clientVersion: input.clientVersion,
    connectedAt: new Date().toISOString(),
  }
}

export function executorPendingConnectionMeta(input: { clientVersion: string }): ConnectionMeta {
  return {
    kind: 'executor',
    label: 'executor pending',
    clientVersion: input.clientVersion,
    connectedAt: new Date().toISOString(),
  }
}

export function executorAnnouncedConnectionMeta(input: {
  current: ConnectionMeta | undefined
  announcement: ExecutorAnnounce
  clientVersion: string
}): ConnectionMeta {
  return {
    kind: 'executor',
    label: executorLabel(input.announcement.workspaceName),
    clientVersion: input.current?.clientVersion ?? input.clientVersion,
    connectedAt: input.current?.connectedAt ?? new Date().toISOString(),
    executorId: input.announcement.executorId,
    workspaceId: input.announcement.workspaceId,
    workspaceName: input.announcement.workspaceName,
  }
}

function dashboardLabel(actor: DashboardActor): string {
  if (actor.kind === 'github_user') return `dashboard ${actor.login}`
  if (actor.kind === 'token') return 'dashboard token'
  return 'dashboard'
}

function executorLabel(workspaceName: string): string {
  const clean = workspaceName.trim()
  return clean.length > 0 ? `executor ${clean}` : 'executor'
}
