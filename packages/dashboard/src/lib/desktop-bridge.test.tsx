import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDesktopBridge, subscribeDesktopSessionOpen, useDesktopBridge, validDesktopEvent, type DesktopEvent } from './desktop-bridge.js'

const desktopWindow = window as Window & { __RUNLAB_DESKTOP__?: boolean; __RUNLAB_DESKTOP_BRIDGE__?: unknown }
afterEach(() => { delete desktopWindow.__RUNLAB_DESKTOP__; delete desktopWindow.__RUNLAB_DESKTOP_BRIDGE__ })

describe('native desktop bridge', () => {
  it('keeps ordinary browsers and old/unknown bridge versions safely unsupported', () => {
    expect(getDesktopBridge()).toBeNull()
    desktopWindow.__RUNLAB_DESKTOP__ = true
    expect(getDesktopBridge()).toBeNull()
    desktopWindow.__RUNLAB_DESKTOP_BRIDGE__ = { version: 2 }
    expect(getDesktopBridge()).toBeNull()
    expect(validDesktopEvent({ type: 'open-session', sessionId: '../bad' })).toBe(false)
    expect(validDesktopEvent({ type: 'execute', command: 'bad' })).toBe(false)
  })
  it('reads installed version and window state with validated events and cleanup', async () => {
    desktopWindow.__RUNLAB_DESKTOP__ = true
    let listener: (event: DesktopEvent) => void = () => {}
    const unsubscribe = vi.fn()
    desktopWindow.__RUNLAB_DESKTOP_BRIDGE__ = {
      version: 1, getInfo: async () => ({ version: '0.2.0-rc.4', focused: true, visible: true }),
      setActivity: vi.fn(), notify: vi.fn(), subscribe: (callback: typeof listener) => { listener = callback; return unsubscribe },
    }
    const { result, unmount } = renderHook(useDesktopBridge)
    await waitFor(() => expect(result.current.info?.version).toBe('0.2.0-rc.4'))
    act(() => listener({ type: 'window-state', focused: false, visible: false }))
    expect(result.current.info?.visible).toBe(false)
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('fails closed on malformed installed info', async () => {
    desktopWindow.__RUNLAB_DESKTOP__ = true
    desktopWindow.__RUNLAB_DESKTOP_BRIDGE__ = { version: 1, getInfo: async () => ({ version: false }), setActivity() {}, notify() {}, subscribe: () => () => {} }
    const { result } = renderHook(useDesktopBridge)
    await waitFor(() => expect(result.current.error).toContain('Invalid'))
    expect(result.current.info).toBeNull()
  })
  it('buffers the latest open-session for a late subscriber and shares one native subscription', async () => {
    desktopWindow.__RUNLAB_DESKTOP__ = true
    let listener: (event: DesktopEvent) => void = () => {}
    const subscribe = vi.fn((callback: typeof listener) => { listener = callback; return () => {} })
    desktopWindow.__RUNLAB_DESKTOP_BRIDGE__ = { version: 1, getInfo: async () => ({ version: '0.2.0-rc.4', focused: true, visible: true }), setActivity() {}, notify() {}, subscribe }
    const first = renderHook(useDesktopBridge)
    await waitFor(() => expect(first.result.current.info).not.toBeNull())
    act(() => { listener({ type: 'open-session', sessionId: 'old' }); listener({ type: 'open-session', sessionId: 'latest' }) })
    const opened = vi.fn()
    const release = subscribeDesktopSessionOpen(getDesktopBridge()!, opened)
    expect(opened).toHaveBeenCalledOnce()
    expect(opened).toHaveBeenCalledWith('latest')
    const second = renderHook(useDesktopBridge)
    expect(second.result.current.info?.version).toBe('0.2.0-rc.4')
    expect(subscribe).toHaveBeenCalledOnce()
    release()
  })
})
