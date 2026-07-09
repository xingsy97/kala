import type { DashboardSocket } from './session.js'

export type WorkspaceExplorerBinding = {
  socket: DashboardSocket | null
  sessionId: string | null
}

export function resolveWorkspaceExplorerBinding(input: {
  activeSessionId: string | null
  sessionSocket: DashboardSocket | null
  controlSocket: DashboardSocket | null
}): WorkspaceExplorerBinding {
  if (input.activeSessionId !== null) {
    return { socket: input.sessionSocket, sessionId: input.activeSessionId }
  }
  return { socket: input.controlSocket, sessionId: null }
}
