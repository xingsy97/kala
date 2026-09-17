import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStoredHostEndpoint, resolveHostEndpoint, setStoredHostEndpoint } from './host-endpoint'

const STORAGE_KEY = 'agent-kernel:host-endpoint'

function setLocation(url: string) {
  const u = new URL(url)
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { search: u.search, origin: u.origin, href: u.href },
  })
}

describe('host-endpoint', () => {
  const originalEnv = { ...import.meta.env }
  beforeEach(() => {
    localStorage.clear()
    setLocation('http://localhost:3000/')
  })
  afterEach(() => {
    ;(import.meta as any).env = originalEnv
  })

  it('defaults to window.location.origin', () => {
    expect(resolveHostEndpoint()).toEqual({ url: 'http://localhost:3000', source: 'default' })
  })

  it('keeps desktop HTTP and Socket.IO on the selected origin despite web overrides', () => {
    Object.defineProperty(window, '__RUNLAB_DESKTOP__', { value: true, configurable: true })
    vi.stubEnv('VITE_AGENT_KERNEL_HOST', 'https://build.example')
    try {
      localStorage.setItem(STORAGE_KEY, 'https://stored.example')
      setLocation('https://desktop.example/?host=https://query.example')
      expect(resolveHostEndpoint()).toEqual({ url: 'https://desktop.example', source: 'default' })
    } finally {
      delete (window as Window & { __RUNLAB_DESKTOP__?: boolean }).__RUNLAB_DESKTOP__
      vi.unstubAllEnvs()
    }
  })

  it('reads build-time VITE_AGENT_KERNEL_HOST', () => {
    vi.stubEnv('VITE_AGENT_KERNEL_HOST', 'http://build.example:4000')
    expect(resolveHostEndpoint()).toEqual({ url: 'http://build.example:4000', source: 'build' })
    vi.unstubAllEnvs()
  })

  it('settings storage overrides build-time', () => {
    vi.stubEnv('VITE_AGENT_KERNEL_HOST', 'http://build.example:4000')
    localStorage.setItem(STORAGE_KEY, 'http://user.example:5000')
    expect(resolveHostEndpoint()).toEqual({ url: 'http://user.example:5000', source: 'settings' })
    vi.unstubAllEnvs()
  })

  it('query param overrides everything', () => {
    vi.stubEnv('VITE_AGENT_KERNEL_HOST', 'http://build.example:4000')
    localStorage.setItem(STORAGE_KEY, 'http://user.example:5000')
    setLocation('http://localhost:3000/?host=http://query.example:6000')
    expect(resolveHostEndpoint()).toEqual({ url: 'http://query.example:6000', source: 'query' })
    vi.unstubAllEnvs()
  })

  it('normalizes trailing slashes', () => {
    localStorage.setItem(STORAGE_KEY, 'http://user.example:5000///')
    expect(resolveHostEndpoint().url).toBe('http://user.example:5000')
  })

  it('setStoredHostEndpoint writes and clears', () => {
    setStoredHostEndpoint('http://new.example')
    expect(getStoredHostEndpoint()).toBe('http://new.example')
    setStoredHostEndpoint(null)
    expect(getStoredHostEndpoint()).toBeNull()
    setStoredHostEndpoint('http://new2.example')
    setStoredHostEndpoint('')
    expect(getStoredHostEndpoint()).toBeNull()
  })
})
