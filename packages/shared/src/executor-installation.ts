export const EXECUTOR_INSTALL_WORKSPACE_ROOT_MAX_LENGTH = 4_096
export const EXECUTOR_INSTALL_LABEL_MAX_LENGTH = 128

export type ExecutorInstallPlatform = 'linux' | 'macos' | 'windows'
export type ExecutorInstallMode = 'service' | 'temporary'

export type ExecutorInstallStatus =
  | 'created'
  | 'bootstrap_downloaded'
  | 'asset_verified'
  | 'pairing_pending'
  | 'paired'
  | 'service_installing'
  | 'starting'
  | 'online'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'expired'

export interface CreateExecutorInstall {
  platform: ExecutorInstallPlatform
  mode: ExecutorInstallMode
  workspaceRoot: string
  label?: string
}

export interface UpdateExecutorInstall {
  platform?: ExecutorInstallPlatform
  mode?: ExecutorInstallMode
  workspaceRoot?: string
  label?: string
}

export interface ExecutorInstallStatusSnapshot {
  id: string
  platform: ExecutorInstallPlatform
  mode: ExecutorInstallMode
  workspaceRoot: string
  label?: string
  status: ExecutorInstallStatus
  seq: number
  createdAt: string
  updatedAt: string
  expiresAt: string
  errorCode?: string
}

export type ExecutorInstallEventMetadata = Readonly<Record<string, unknown>>

export interface ExecutorInstallEvent {
  installationId: string
  seq: number
  timestamp: string
  status: ExecutorInstallStatus
  errorCode?: string
  metadata?: ExecutorInstallEventMetadata
}

export const EXECUTOR_INSTALL_ALLOWED_STATUS_TRANSITIONS = {
  created: ['bootstrap_downloaded', 'expired'],
  bootstrap_downloaded: ['asset_verified', 'failed'],
  asset_verified: ['pairing_pending', 'failed'],
  pairing_pending: ['paired', 'rejected', 'expired'],
  paired: ['service_installing', 'starting'],
  service_installing: ['starting', 'failed'],
  starting: ['online', 'failed'],
  online: ['completed'],
  completed: [],
  failed: [],
  rejected: [],
  expired: [],
} as const satisfies Readonly<Record<ExecutorInstallStatus, readonly ExecutorInstallStatus[]>>

export function isExecutorInstallStatusTransitionAllowed(
  from: ExecutorInstallStatus,
  to: ExecutorInstallStatus,
  mode?: ExecutorInstallMode,
): boolean {
  if (from === 'paired' && mode !== undefined) {
    return mode === 'service' ? to === 'service_installing' : to === 'starting'
  }

  return (EXECUTOR_INSTALL_ALLOWED_STATUS_TRANSITIONS[from] as readonly ExecutorInstallStatus[]).includes(to)
}
