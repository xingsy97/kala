import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

import {
  canSendDesktopNotification,
  playNotificationSound,
  requestNotificationPermission,
  sendDesktopNotification,
  useInterventionDesktopNotifications,
  type DesktopNotificationPrefs,
} from './desktop-notifications.js'

const prefs: DesktopNotificationPrefs = {
  enabled: true,
  sound: true,
  byKind: {
    approval_required: true,
    waiting_for_user: true,
    session_error: true,
    connection_lost: true,
    workspace_offline: true,
  },
}

describe('desktop notification helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubAudioContext(): { AudioContextMock: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
    const close = vi.fn().mockResolvedValue(undefined)
    const oscillator = {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    }
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    }
    const AudioContextMock = vi.fn().mockImplementation(() => ({
      currentTime: 1,
      destination: {},
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
      close,
    }))
    vi.stubGlobal('AudioContext', AudioContextMock)
    return { AudioContextMock, close }
  }

  it('does not send when the browser API is missing', () => {
    vi.stubGlobal('Notification', undefined)

    expect(canSendDesktopNotification(prefs, 'approval_required')).toBe(false)
    expect(sendDesktopNotification(prefs, 'approval_required', 'Approval required')).toBe(false)
  })

  it('requests permission through the browser API', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const NotificationMock = vi.fn()
    Object.assign(NotificationMock, { permission: 'default', requestPermission })
    vi.stubGlobal('Notification', NotificationMock)

    await expect(requestNotificationPermission()).resolves.toBe('granted')
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('sends only when global and per-kind prefs are enabled and permission is granted', () => {
    const NotificationMock = vi.fn().mockImplementation(() => ({ close: vi.fn(), onclick: null }))
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    const { AudioContextMock } = stubAudioContext()

    expect(sendDesktopNotification(prefs, 'approval_required', 'Approval required')).toBe(true)
    expect(NotificationMock).toHaveBeenCalledWith('Approval required', expect.objectContaining({ tag: 'agent-kernel-approval_required' }))
    expect(AudioContextMock).toHaveBeenCalledTimes(1)

    expect(sendDesktopNotification({ ...prefs, enabled: false }, 'approval_required', 'Nope')).toBe(false)
    expect(sendDesktopNotification({ ...prefs, byKind: { ...prefs.byKind, approval_required: false } }, 'approval_required', 'Nope')).toBe(false)
  })

  it('plays notification sound only when the sound preference is enabled', () => {
    const NotificationMock = vi.fn().mockImplementation(() => ({ close: vi.fn(), onclick: null }))
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    const { AudioContextMock } = stubAudioContext()

    expect(playNotificationSound()).toBe(true)
    expect(AudioContextMock).toHaveBeenCalledTimes(1)

    expect(sendDesktopNotification({ ...prefs, sound: false }, 'session_error', 'No sound')).toBe(true)
    expect(AudioContextMock).toHaveBeenCalledTimes(1)
  })

  it('notifies on intervention state transitions without repeating the same signature', () => {
    localStorage.setItem('ak-desktop-notifications-enabled', '1')
    const NotificationMock = vi.fn().mockImplementation(() => ({ close: vi.fn(), onclick: null }))
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)

    function Harness(props: Partial<Parameters<typeof useInterventionDesktopNotifications>[0]>): JSX.Element {
      useInterventionDesktopNotifications({
        sessionId: 's1',
        sessionLabel: 'demo session',
        pendingApprovalsCount: 0,
        waitingForUser: false,
        lastError: null,
        connectionStatus: 'ready',
        workspaceOnline: true,
        ...props,
      })
      return <div />
    }

    const { rerender } = render(<Harness />)
    expect(NotificationMock).not.toHaveBeenCalled()

    rerender(<Harness pendingApprovalsCount={1} pendingApprovalSummary={{ callId: 'c1', name: 'bash' }} />)
    expect(NotificationMock).toHaveBeenCalledWith('Approval required', expect.objectContaining({ body: 'demo session: bash' }))

    rerender(<Harness pendingApprovalsCount={1} pendingApprovalSummary={{ callId: 'c1', name: 'bash' }} />)
    expect(NotificationMock).toHaveBeenCalledTimes(1)

    rerender(<Harness connectionStatus="disconnected" />)
    expect(NotificationMock).toHaveBeenCalledWith('Host disconnected', expect.any(Object))

    rerender(<Harness workspaceOnline={false} workspaceLabel="ws-a" />)
    expect(NotificationMock).toHaveBeenCalledWith('Workspace offline', expect.objectContaining({ body: 'demo session: ws-a is offline' }))
  })

  it('suppresses the approval desktop notification when approvalMode is allow_all', () => {
    localStorage.setItem('ak-desktop-notifications-enabled', '1')
    const NotificationMock = vi.fn().mockImplementation(() => ({ close: vi.fn(), onclick: null }))
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)

    function Harness(props: Partial<Parameters<typeof useInterventionDesktopNotifications>[0]>): JSX.Element {
      useInterventionDesktopNotifications({
        sessionId: 's1',
        sessionLabel: 'demo session',
        pendingApprovalsCount: 0,
        waitingForUser: false,
        lastError: null,
        connectionStatus: 'ready',
        workspaceOnline: true,
        approvalMode: 'allow_all',
        ...props,
      })
      return <div />
    }

    const { rerender } = render(<Harness />)
    rerender(<Harness pendingApprovalsCount={1} pendingApprovalSummary={{ callId: 'c1', name: 'bash' }} />)
    // Kernel auto-dispatches under allow_all, so the operator should not be
    // pinged even if a transient pending call briefly reaches the client.
    expect(NotificationMock).not.toHaveBeenCalledWith('Approval required', expect.anything())
  })

  it('notifies when a busy session becomes ready for user input', () => {
    localStorage.setItem('ak-desktop-notifications-enabled', '1')
    const NotificationMock = vi.fn().mockImplementation(() => ({ close: vi.fn(), onclick: null }))
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)

    function Harness({ waitingForUser }: { waitingForUser: boolean }): JSX.Element {
      useInterventionDesktopNotifications({
        sessionId: 's1',
        sessionLabel: 'demo session',
        pendingApprovalsCount: 0,
        waitingForUser,
        lastError: null,
        connectionStatus: 'ready',
        workspaceOnline: true,
      })
      return <div />
    }

    const { rerender } = render(<Harness waitingForUser={false} />)
    expect(NotificationMock).not.toHaveBeenCalled()

    rerender(<Harness waitingForUser />)
    expect(NotificationMock).toHaveBeenCalledWith('Waiting for you', expect.objectContaining({ body: 'demo session: ready for your next message' }))

    rerender(<Harness waitingForUser />)
    expect(NotificationMock).toHaveBeenCalledTimes(1)
  })

  it('can suppress the ready notification for a user-initiated message round trip', () => {
    localStorage.setItem('ak-desktop-notifications-enabled', '1')
    const NotificationMock = vi.fn().mockImplementation(() => ({ close: vi.fn(), onclick: null }))
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    const { AudioContextMock } = stubAudioContext()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    function Harness({ waitingForUser, suppressWaitingForUser }: { waitingForUser: boolean; suppressWaitingForUser?: boolean }): JSX.Element {
      useInterventionDesktopNotifications({
        sessionId: 's1',
        sessionLabel: 'demo session',
        pendingApprovalsCount: 0,
        waitingForUser,
        lastError: null,
        connectionStatus: 'ready',
        workspaceOnline: true,
        suppressWaitingForUser,
      })
      return <div />
    }

    const { rerender } = render(<Harness waitingForUser={false} />)
    rerender(<Harness waitingForUser suppressWaitingForUser />)
    expect(NotificationMock).not.toHaveBeenCalled()
    expect(AudioContextMock).not.toHaveBeenCalled()

    rerender(<Harness waitingForUser={false} />)
    rerender(<Harness waitingForUser />)
    expect(AudioContextMock).toHaveBeenCalledTimes(1)
  })

  it('plays only local sound when the focused dashboard becomes ready for user input', () => {
    localStorage.setItem('ak-desktop-notifications-enabled', '1')
    const NotificationMock = vi.fn().mockImplementation(() => ({ close: vi.fn(), onclick: null }))
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    const { AudioContextMock } = stubAudioContext()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    function Harness({ waitingForUser }: { waitingForUser: boolean }): JSX.Element {
      useInterventionDesktopNotifications({
        sessionId: 's1',
        sessionLabel: 'demo session',
        pendingApprovalsCount: 0,
        waitingForUser,
        lastError: null,
        connectionStatus: 'ready',
        workspaceOnline: true,
      })
      return <div />
    }

    const { rerender } = render(<Harness waitingForUser={false} />)
    rerender(<Harness waitingForUser />)

    expect(NotificationMock).not.toHaveBeenCalled()
    expect(AudioContextMock).toHaveBeenCalledTimes(1)
  })

  it('does not treat switching sessions as a new waiting-for-user transition', () => {
    localStorage.setItem('ak-desktop-notifications-enabled', '1')
    const NotificationMock = vi.fn().mockImplementation(() => ({ close: vi.fn(), onclick: null }))
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    const { AudioContextMock } = stubAudioContext()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    function Harness({ sessionId, waitingForUser }: { sessionId: string; waitingForUser: boolean }): JSX.Element {
      useInterventionDesktopNotifications({
        sessionId,
        sessionLabel: sessionId,
        pendingApprovalsCount: 0,
        waitingForUser,
        lastError: null,
        connectionStatus: 'ready',
        workspaceOnline: true,
      })
      return <div />
    }

    const { rerender } = render(<Harness sessionId="running" waitingForUser={false} />)
    rerender(<Harness sessionId="idle" waitingForUser />)

    expect(NotificationMock).not.toHaveBeenCalled()
    expect(AudioContextMock).not.toHaveBeenCalled()
  })

  it('does not notify when a newly selected session becomes hydrated already waiting', () => {
    localStorage.setItem('ak-desktop-notifications-enabled', '1')
    const NotificationMock = vi.fn().mockImplementation(() => ({ close: vi.fn(), onclick: null }))
    Object.assign(NotificationMock, { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    const { AudioContextMock } = stubAudioContext()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    function Harness({ ready, waitingForUser }: { ready: boolean; waitingForUser: boolean }): JSX.Element {
      useInterventionDesktopNotifications({
        sessionId: 'selected-session',
        sessionLabel: 'selected-session',
        pendingApprovalsCount: 0,
        waitingForUser,
        lastError: null,
        connectionStatus: 'ready',
        workspaceOnline: true,
        ready,
      })
      return <div />
    }

    const { rerender } = render(<Harness ready={false} waitingForUser={false} />)
    rerender(<Harness ready={false} waitingForUser />)
    rerender(<Harness ready waitingForUser />)

    expect(NotificationMock).not.toHaveBeenCalled()
    expect(AudioContextMock).not.toHaveBeenCalled()
  })
})
