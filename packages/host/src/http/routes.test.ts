import { createServer, type ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { attachJsonRoutes } from './routes.js'
import { PRIVATE_CLOUD_DEPLOYMENT } from '@agent-kernel/shared'

describe('HTTP route ownership', () => {
  it('does not touch Engine.IO response headers', () => {
    const server = createServer()
    attachJsonRoutes(server, {})
    const listener = server.listeners('request')[0]
    expect(listener).toBeTypeOf('function')
    const setHeader = vi.fn(() => { throw new Error('headers already sent') })
    expect(() => listener?.(
      { url: '/socket.io/?EIO=4&transport=polling', headers: { origin: 'https://browser.example.test' } },
      { setHeader } as unknown as ServerResponse,
    )).not.toThrow()
    expect(setHeader).not.toHaveBeenCalled()
  })

  it('requires tenant admins for multi-tenant settings write routes', async () => {
    const calls: string[] = []
    const server = createServer()
    attachJsonRoutes(server, {
      models: [],
      defaultModel: '',
      deployment: PRIVATE_CLOUD_DEPLOYMENT,
      addManualModel: () => { calls.push('model:add'); return { models: [], providers: [] } as never },
      deleteManualModel: () => { calls.push('model:delete'); return { models: [], providers: [] } as never },
      addManualProvider: () => { calls.push('provider:add'); return { models: [], providers: [] } as never },
      deleteManualProvider: () => { calls.push('provider:delete'); return { models: [], providers: [] } as never },
      setDefaultModel: () => { calls.push('default-model'); return { models: [], providers: [] } as never },
      updateAgentPrompt: () => { calls.push('agent-prompt'); return { models: [], providers: [] } as never },
      initializeSocketAdmin: () => { calls.push('socket-admin:init'); return { models: [], providers: [] } as never },
      updateSocketAdminMode: () => { calls.push('socket-admin:mode'); return { models: [], providers: [] } as never },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing address')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const memberHeaders = {
        'content-type': 'application/json',
        'x-agent-runlab-principal': 'member@example.test',
        'x-agent-runlab-organization-id': 'org_settings',
        'x-agent-runlab-organization-role': 'member',
      }
      const adminHeaders = {
        'content-type': 'application/json',
        'x-agent-runlab-principal': 'admin@example.test',
        'x-agent-runlab-organization-id': 'org_settings',
        'x-agent-runlab-organization-role': 'admin',
      }
      const requests: Array<[string, RequestInit]> = [
        ['/settings/models', { method: 'POST', body: JSON.stringify({ providerId: 'custom', id: 'model', label: 'Model' }) }],
        ['/settings/models?providerId=custom&id=model', { method: 'DELETE' }],
        ['/settings/providers', { method: 'POST', body: JSON.stringify({ id: 'custom', label: 'Custom', baseUrl: 'https://example.test', apiKey: 'not-a-real-key' }) }],
        ['/settings/providers?providerId=custom', { method: 'DELETE' }],
        ['/settings/default-model', { method: 'POST', body: JSON.stringify({ model: 'custom:model' }) }],
        ['/settings/agent-prompt', { method: 'POST', body: JSON.stringify({ preset: 'custom', customPrompt: 'safe prompt' }) }],
        ['/settings/socket-admin/init', { method: 'POST', body: JSON.stringify({ password: 'password-1234' }) }],
        ['/settings/socket-admin/mode', { method: 'POST', body: JSON.stringify({ mode: 'production' }) }],
      ]
      for (const [path, init] of requests) {
        const blocked = await fetch(`${baseUrl}${path}`, { ...init, headers: memberHeaders })
        expect(blocked.status).toBe(403)
        await expect(blocked.json()).resolves.toMatchObject({ error: 'admin_required' })
      }
      expect(calls).toEqual([])

      const allowed = await fetch(`${baseUrl}/settings/socket-admin/mode`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ mode: 'production' }),
      })
      expect(allowed.status).toBe(200)
      expect(calls).toEqual(['socket-admin:mode'])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
