import { afterEach, describe, expect, it } from 'vitest'

import { loadSocketAdminConfig } from './socket-admin.js'

const ORIGINAL_MODE = process.env.AGENT_KERNEL_SOCKET_ADMIN_MODE

afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.AGENT_KERNEL_SOCKET_ADMIN_MODE
  else process.env.AGENT_KERNEL_SOCKET_ADMIN_MODE = ORIGINAL_MODE
})

describe('loadSocketAdminConfig', () => {
  it('defaults Socket.IO Admin UI mode to development before initialization', () => {
    delete process.env.AGENT_KERNEL_SOCKET_ADMIN_MODE

    const state = loadSocketAdminConfig({
      currentModulePath: import.meta.url,
      configPath: '/tmp/socket-admin.json',
      record: null,
      embeddedAssets: [],
    })

    expect(state.summary.runtimeMode).toBe('development')
    expect(state.summary.configuredMode).toBe('development')
  })

  it('defaults old initialized records without mode to development', () => {
    delete process.env.AGENT_KERNEL_SOCKET_ADMIN_MODE

    const state = loadSocketAdminConfig({
      currentModulePath: import.meta.url,
      configPath: '/tmp/socket-admin.json',
      record: {
        version: 1,
        username: 'admin',
        passwordHash: '$2b$10$012345678901234567890u7Z/08sx9Loa7TXHL62ojTkhUMYeOHpu',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      embeddedAssets: [{ path: 'index.html', contentBase64: '' }],
    })

    expect(state.runtime?.mode).toBe('development')
    expect(state.summary.runtimeMode).toBe('development')
  })

  it('allows explicit production mode from the environment', () => {
    process.env.AGENT_KERNEL_SOCKET_ADMIN_MODE = 'production'

    const state = loadSocketAdminConfig({
      currentModulePath: import.meta.url,
      configPath: '/tmp/socket-admin.json',
      record: null,
      embeddedAssets: [],
    })

    expect(state.summary.runtimeMode).toBe('production')
  })
})
