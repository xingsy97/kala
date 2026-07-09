import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSettingsPayload } from '@agent-kernel/shared'

import { SettingsDialog } from './SettingsDialog.js'

const payload: ServerSettingsPayload = {
  providers: [
    {
      id: 'anthropic',
      label: 'Anthropic',
      wire: 'anthropic',
      source: 'claude-settings',
      baseUrl: 'http://private-3.example.com/v1',
      models: [
        { id: 'claude-opus-4-7', label: 'claude-opus-4-7', provider: 'Anthropic', providerId: 'anthropic', source: 'claude-settings' },
        { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', provider: 'Anthropic', providerId: 'anthropic', source: 'claude-settings' },
        { id: 'claude-haiku-4-6', label: 'claude-haiku-4-6', provider: 'Anthropic', providerId: 'anthropic', source: 'manual' },
      ],
    },
    {
      id: 'openai-compat',
      label: 'internal-router',
      wire: 'openai',
      source: 'codex-config',
      models: [],
    },
  ],
  defaultModel: 'claude-opus-4-7',
  hooks: [
    { event: 'pre_tool_use', match: 'bash', command: '/usr/local/bin/lint.sh' },
    { event: 'post_tool_use', command: '/usr/local/bin/log.sh' },
  ],
  paths: {
    claudeSettings: '<home>/.claude/settings.json',
    codexConfig: '<home>/.codex/config.toml',
    manualModels: '<home>/.config/agent-kernel/models.json',
    hooksConfig: '<home>/.config/agent-kernel/config.toml',
    sessionsDir: '<home>/.agent-kernel/sessions',
  },
  mcp: {
    supported: false,
    note: 'MCP runtime is not implemented yet — see docs/mcp.md for the planned design.',
  },
}

describe('SettingsDialog', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not render when closed', () => {
    render(<SettingsDialog open={false} onOpenChange={() => {}} />)
    expect(screen.queryByTestId('settings-dialog')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches /settings on open and shows runtime paths by default', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings', { cache: 'no-store' })
    })

    await screen.findByText('<home>/.claude/settings.json')
    expect(screen.getByText('<home>/.codex/config.toml')).toBeTruthy()
    expect(screen.getByText('<home>/.agent-kernel/sessions')).toBeTruthy()
  })

  it('switches to Models tab and lists providers + default model', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-models'))

    const anthropic = await screen.findByTestId('settings-provider-anthropic')
    expect(anthropic.textContent).toContain('Anthropic')
    expect(anthropic.textContent).toContain('claude-opus-4-7')
    expect(anthropic.textContent).toContain('claude-sonnet-4-6')
    expect(anthropic.textContent).toContain('claude-haiku-4-6')
    expect(anthropic.textContent).toContain('default provider')
    expect(anthropic.textContent).toContain('Claude Code')
    expect(anthropic.textContent).toContain('Manual')

    const other = screen.getByTestId('settings-provider-openai-compat')
    expect(other.textContent).toContain('No model attached')
  })

  it('does not label missing source metadata as manual', async () => {
    const sourceLess: ServerSettingsPayload = {
      ...payload,
      providers: [
        {
          id: 'legacy-provider',
          label: 'legacy-provider',
          wire: 'openai',
          models: [{ id: 'gpt-legacy', label: 'gpt-legacy', provider: 'legacy-provider', providerId: 'legacy-provider' }],
        },
      ],
    }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(sourceLess), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-models'))
    const provider = await screen.findByTestId('settings-provider-legacy-provider')
    expect(provider.textContent).toContain('Unknown')
    expect(provider.textContent).not.toContain('Manual')
    expect(screen.queryByLabelText('delete model gpt-legacy')).toBeNull()
  })

  it('adds and deletes manual models', async () => {
    const nextPayload: ServerSettingsPayload = {
      ...payload,
      providers: payload.providers.map((p) => p.id === 'openai-compat'
        ? {
            ...p,
            models: [{ id: 'gpt-5.5-mini', label: 'GPT 5.5 Mini', provider: p.label, providerId: p.id, source: 'manual' }],
          }
        : p),
    }
    const onModelsChanged = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} onModelsChanged={onModelsChanged} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-models'))
    fireEvent.change(screen.getByTestId('settings-model-provider-select'), { target: { value: 'openai-compat' } })
    fireEvent.change(screen.getByTestId('settings-model-id-input'), { target: { value: 'gpt-5.5-mini' } })
    fireEvent.click(screen.getByRole('button', { name: /add/i }))

    await screen.findByText('gpt-5.5-mini')
    expect(fetchMock).toHaveBeenCalledWith('/settings/models', expect.objectContaining({ method: 'POST' }))
    expect(onModelsChanged).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByLabelText('delete model gpt-5.5-mini'))
    await screen.findByText(/No model attached/)
    expect(fetchMock).toHaveBeenCalledWith('/settings/models?providerId=openai-compat&id=gpt-5.5-mini', { method: 'DELETE' })
    expect(onModelsChanged).toHaveBeenCalledTimes(2)
  })

  it('renders hooks table when hooks are configured', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-hooks'))
    await screen.findByText('/usr/local/bin/lint.sh')
    expect(screen.getByText('/usr/local/bin/log.sh')).toBeTruthy()
    expect(screen.getByText('pre_tool_use')).toBeTruthy()
    expect(screen.getByText('post_tool_use')).toBeTruthy()
  })

  it('flags MCP as not implemented', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-mcp'))
    await screen.findByText('Not implemented yet')
    expect(screen.getAllByText(/docs\/mcp\.md/i).length).toBeGreaterThan(0)
  })

  it('surfaces a fetch failure without crashing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    render(<SettingsDialog open onOpenChange={() => {}} />)

    await screen.findByText(/network down/i)
  })

  it('configures desktop notification permission and per-kind toggles', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    const requestPermission = vi.fn().mockResolvedValue('granted')
    const NotificationMock = vi.fn()
    Object.assign(NotificationMock, { permission: 'default', requestPermission })
    vi.stubGlobal('Notification', NotificationMock)
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    expect(screen.getByTestId('desktop-notification-permission').textContent).toContain('not requested')

    fireEvent.click(screen.getByTestId('settings-toggle-desktop-notifications'))
    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1)
    })
    expect(localStorage.getItem('ak-desktop-notifications-enabled')).toBe('1')

    fireEvent.click(screen.getByTestId('settings-toggle-notification-ak-desktop-notification-sound'))
    expect(localStorage.getItem('ak-desktop-notification-sound')).toBe('0')

    fireEvent.click(screen.getByTestId('settings-toggle-notification-ak-desktop-notification-session-error'))
    expect(localStorage.getItem('ak-desktop-notification-session-error')).toBe('0')
  })

  it('keeps desktop notifications disabled when browser permission is denied', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    const NotificationMock = vi.fn()
    Object.assign(NotificationMock, { permission: 'denied', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await screen.findByText('<home>/.claude/settings.json')

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    const toggle = screen.getByTestId('settings-toggle-desktop-notifications') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/Notifications are blocked/i)).toBeTruthy()
  })
})
