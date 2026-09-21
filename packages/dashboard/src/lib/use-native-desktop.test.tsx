import { EventEmitter } from 'node:events'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@agent-kernel/shared'
import type { DashboardSocket } from '../session.js'
import '../i18n/index.js'
import { useNativeDesktop } from './use-native-desktop.js'
import type { DesktopBridge, DesktopEvent } from './desktop-bridge.js'
import { DASHBOARD_PREFERENCES } from './prefs.js'
import { notify } from '../notify.js'

vi.mock('../notify.js', () => ({ notify: { error: vi.fn() } }))
const desktopWindow = window as Window & { __RUNLAB_DESKTOP__?: boolean; __RUNLAB_DESKTOP_BRIDGE__?: unknown }
const summary = (sessionId: string, status: SessionSummary['status'], eventCount = 1): SessionSummary => ({
  sessionId, status, eventCount, agentRuntime: 'kernel', createdAt: '2026-09-15', label: 'Private conversation',
})

describe('native desktop runtime signals', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete desktopWindow.__RUNLAB_DESKTOP__; delete desktopWindow.__RUNLAB_DESKTOP_BRIDGE__ })

  async function fixture({ enabled = true, focused = false, visible = false, details = false, ready = true, earlySession = '', infoError = '', subscribeError = '' } = {}) {
    desktopWindow.__RUNLAB_DESKTOP__ = true
    localStorage.setItem(DASHBOARD_PREFERENCES.desktopNotificationsEnabled.key, enabled ? 'true' : 'false')
    localStorage.setItem(DASHBOARD_PREFERENCES.desktopNotificationDetails.key, details ? 'true' : 'false')
    const events = new Set<(event: DesktopEvent) => void>()
    const bridge: DesktopBridge = {
      version: 1,
      getInfo: vi.fn(async () => {
        if (infoError) throw new Error(infoError)
        return { version: '0.2.0-rc.4', focused, visible, notificationsAvailable: true }
      }),
      notify: vi.fn(async () => {}), setActivity: vi.fn(async () => {}),
      confirmConnection: vi.fn(async () => {}),
      subscribe: (listener) => {
        if (subscribeError) throw new Error(subscribeError)
        events.add(listener)
        if (earlySession) listener({ type: 'open-session', sessionId: earlySession })
        return () => events.delete(listener)
      },
    }
    desktopWindow.__RUNLAB_DESKTOP_BRIDGE__ = bridge
    const socket = Object.assign(new EventEmitter(), { connected: true })
    const onOpenSession = vi.fn()
    const initial = { sessions: ready ? [summary('active', 'thinking'), summary('background', 'thinking')] : [], activeSessionId: 'active', viewedSessionId: 'active' as string | null, socket: socket as unknown as DashboardSocket, ready, workspaceOnline: true, onOpenSession }
    const hook = renderHook((props) => useNativeDesktop(props), { initialProps: initial })
    await act(async () => {})
    const emit = (event: DesktopEvent) => act(() => { for (const listener of events) listener(event) })
    return { bridge, hook, initial, socket, onOpenSession, emit }
  }

  it('confirms an endpoint only after a successful authoritative control connection', async () => {
    const { bridge, hook, initial, socket } = await fixture({ ready: false })
    expect(bridge.confirmConnection).not.toHaveBeenCalled()
    hook.rerender({ ...initial, ready: true, sessions: [summary('active', 'idle')] })
    expect(bridge.confirmConnection).not.toHaveBeenCalled()
    act(() => { socket.emit('server:sessions') })
    expect(bridge.confirmConnection).toHaveBeenCalledTimes(1)
    hook.rerender({ ...initial, ready: true, sessions: [summary('active', 'thinking')] })
    expect(bridge.confirmConnection).toHaveBeenCalledTimes(1)
    act(() => { socket.emit('disconnect'); socket.emit('connect') })
    expect(bridge.confirmConnection).toHaveBeenCalledTimes(1)
    act(() => { socket.emit('server:sessions') })
    expect(bridge.confirmConnection).toHaveBeenCalledTimes(2)
  })

  it('notifies selected hidden and background sessions once, privately, without history/reconnect spam', async () => {
    const { bridge, hook, initial, socket } = await fixture()
    expect(bridge.notify).not.toHaveBeenCalled()
    hook.rerender({ ...initial, sessions: [summary('active', 'done', 2), summary('background', 'done', 2)] })
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(bridge.notify).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(bridge.notify).mock.calls.map(([value]) => value)
    expect(calls.map((value) => value.sessionId)).toEqual(['active', 'background'])
    expect(calls.every((value) => !value.body.includes('Private') && value.title === 'Kala')).toBe(true)
    hook.rerender({ ...initial, sessions: [summary('active', 'done', 2), summary('background', 'done', 2)] })
    act(() => { socket.emit('disconnect'); socket.emit('connect'); socket.emit('server:sessions') })
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(bridge.notify).toHaveBeenCalledTimes(2)
  })
  it('does not mistake a later state-only turn with unchanged eventCount for a duplicate', async () => {
    const { bridge, hook, initial } = await fixture()
    hook.rerender({ ...initial, sessions: [summary('active', 'done', 1)] })
    await act(async () => { vi.advanceTimersByTime(1500) })
    hook.rerender({ ...initial, sessions: [summary('active', 'thinking', 1)] })
    hook.rerender({ ...initial, sessions: [summary('active', 'done', 1)] })
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(bridge.notify).toHaveBeenCalledTimes(2)
    expect(vi.mocked(bridge.notify).mock.calls[0]![0].id).not.toBe(vi.mocked(bridge.notify).mock.calls[1]![0].id)
  })
  it('suppresses only the focused/visible selected session and restores notifications while hidden', async () => {
    const { bridge, hook, initial, emit } = await fixture({ focused: true, visible: true })
    hook.rerender({ ...initial, sessions: [summary('active', 'awaiting_approval', 2), summary('background', 'awaiting_approval', 2)] })
    expect(bridge.notify).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bridge.notify).mock.calls[0]![0].sessionId).toBe('background')
    emit({ type: 'window-state', focused: false, visible: false })
    hook.rerender({ ...initial, sessions: [summary('active', 'thinking', 3), summary('background', 'awaiting_approval', 2)] })
    hook.rerender({ ...initial, sessions: [summary('active', 'awaiting_approval', 4), summary('background', 'awaiting_approval', 2)] })
    expect(bridge.notify).toHaveBeenCalledTimes(2)
    expect(vi.mocked(bridge.notify).mock.calls[1]![0].sessionId).toBe('active')
  })
  it('notifies the selected session when another app section or overlay is being viewed', async () => {
    const { bridge, hook, initial } = await fixture({ focused: true, visible: true })
    const otherSection = { ...initial, viewedSessionId: null }
    hook.rerender({ ...otherSection, sessions: [summary('active', 'awaiting_approval', 2)] })
    expect(bridge.notify).toHaveBeenCalledOnce()
    expect(vi.mocked(bridge.notify).mock.calls[0]![0].sessionId).toBe('active')
    hook.rerender({ ...otherSection, sessions: [summary('active', 'thinking', 3)] })
    hook.rerender({ ...otherSection, sessions: [summary('active', 'done', 4)] })
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(bridge.notify).toHaveBeenCalledTimes(2)
    expect(vi.mocked(bridge.setActivity).mock.lastCall?.[0].completed).toBe(1)
    hook.rerender({ ...initial, sessions: [summary('active', 'done', 4)] })
    expect(vi.mocked(bridge.setActivity).mock.lastCall?.[0].completed).toBe(0)
  })
  it('keeps tray activity independent of OS preferences and ignores queued/intermediate completion', async () => {
    const { bridge, hook, initial } = await fixture({ enabled: false })
    hook.rerender({ ...initial, sessions: [{ ...summary('background', 'done', 2), queuedCount: 1 }] })
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(bridge.notify).not.toHaveBeenCalled()
    expect(vi.mocked(bridge.setActivity).mock.lastCall?.[0].running).toBe(1)
    hook.rerender({ ...initial, sessions: [summary('background', 'done', 3)] })
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(vi.mocked(bridge.setActivity).mock.lastCall?.[0].completed).toBe(1)
    expect(bridge.notify).not.toHaveBeenCalled()
  })
  it('uses the opt-in details preference, surfaces failed native delivery, and deduplicates failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { bridge, hook, initial } = await fixture({ details: true })
    vi.mocked(bridge.notify).mockRejectedValue(new Error('Notification service rejected delivery'))
    hook.rerender({ ...initial, sessions: [summary('active', 'error', 2)] })
    await act(async () => {})
    expect(vi.mocked(bridge.notify).mock.calls[0]![0].body).toContain('Private conversation')
    expect(error).toHaveBeenCalled()
    expect(notify.error).toHaveBeenCalledOnce()
    hook.rerender({ ...initial, sessions: [summary('active', 'error', 2)] })
    await act(async () => {})
    expect(bridge.notify).toHaveBeenCalledOnce()
  })
  it('selects only existing validated session callbacks without navigation', async () => {
    const { emit, onOpenSession } = await fixture()
    const before = window.location.href
    emit({ type: 'open-session', sessionId: 'background' })
    expect(onOpenSession).toHaveBeenCalledWith('background')
    emit({ type: 'open-session', sessionId: 'missing' })
    expect(onOpenSession).toHaveBeenCalledTimes(1)
    expect(notify.error).toHaveBeenCalled()
    expect(window.location.href).toBe(before)
  })
  it('retains a cold-launch deep link arriving on subscribe until the initial authoritative snapshot', async () => {
    const { hook, initial, socket, onOpenSession } = await fixture({ ready: false, earlySession: 'target' })
    expect(onOpenSession).not.toHaveBeenCalled()
    expect(notify.error).not.toHaveBeenCalled()
    await act(async () => {
      socket.emit('server:sessions')
      hook.rerender({ ...initial, ready: true, sessions: [summary('target', 'idle')] })
    })
    expect(onOpenSession).toHaveBeenCalledOnce()
    expect(onOpenSession).toHaveBeenCalledWith('target')
    expect(notify.error).not.toHaveBeenCalled()
  })
  it('keeps only the latest queued link through reconnect, and reports missing only after a fresh snapshot', async () => {
    const { hook, initial, socket, emit, onOpenSession } = await fixture()
    act(() => socket.emit('disconnect'))
    emit({ type: 'open-session', sessionId: 'superseded' })
    emit({ type: 'open-session', sessionId: 'target' })
    act(() => socket.emit('connect'))
    hook.rerender({ ...initial, sessions: [summary('target', 'idle')] })
    expect(onOpenSession).not.toHaveBeenCalled()
    expect(notify.error).not.toHaveBeenCalled()
    act(() => socket.emit('server:sessions'))
    expect(onOpenSession).toHaveBeenCalledOnce()
    expect(onOpenSession).toHaveBeenCalledWith('target')
    act(() => socket.emit('disconnect'))
    emit({ type: 'open-session', sessionId: 'missing' })
    expect(notify.error).not.toHaveBeenCalled()
    act(() => { socket.emit('connect'); socket.emit('server:sessions') })
    expect(notify.error).toHaveBeenCalledOnce()
  })
  it.each(['getInfo', 'subscribe'])('surfaces %s bridge failure once even without native info', async (method) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { hook, initial } = await fixture(method === 'getInfo' ? { infoError: 'Native info failure' } : { subscribeError: 'Native subscription failure' })
    expect(error).toHaveBeenCalledOnce()
    expect(notify.error).toHaveBeenCalledOnce()
    hook.rerender(initial)
    expect(notify.error).toHaveBeenCalledOnce()
  })
  it('uses positive subagent metadata, not fork parenthood, to exclude native activity', async () => {
    const { hook, initial, socket, bridge } = await fixture()
    Object.assign(socket, { timeout: () => ({ emitWithAck: async () => ({
      requestId: 'test', parentSessionId: 'original',
      children: [{ childSessionId: 'fork', status: 'running' }, { childSessionId: 'tool-child', status: 'running', parentCallId: 'call-1' }],
    }) }) })
    await act(async () => hook.rerender({ ...initial, sessions: [
      { ...summary('fork', 'thinking'), parentSessionId: 'original' },
      { ...summary('tool-child', 'thinking'), parentSessionId: 'original' },
    ] }))
    expect(vi.mocked(bridge.setActivity).mock.lastCall?.[0].running).toBe(1)
  })
})
