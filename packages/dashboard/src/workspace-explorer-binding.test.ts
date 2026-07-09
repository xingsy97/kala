import { describe, expect, it } from 'vitest'

import type { DashboardSocket } from './session.js'
import { resolveWorkspaceExplorerBinding } from './workspace-explorer-binding.js'

describe('resolveWorkspaceExplorerBinding', () => {
  it('uses the selected session socket for session-scoped workspace surfaces', () => {
    const sessionSocket = {} as DashboardSocket
    const controlSocket = {} as DashboardSocket

    expect(resolveWorkspaceExplorerBinding({
      activeSessionId: 'sess-1',
      sessionSocket,
      controlSocket,
    })).toEqual({ socket: sessionSocket, sessionId: 'sess-1' })
  })

  it('uses the control socket only for unscoped workspace browsing', () => {
    const sessionSocket = {} as DashboardSocket
    const controlSocket = {} as DashboardSocket

    expect(resolveWorkspaceExplorerBinding({
      activeSessionId: null,
      sessionSocket,
      controlSocket,
    })).toEqual({ socket: controlSocket, sessionId: null })
  })
})
