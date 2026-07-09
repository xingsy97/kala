import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachedExecutor, ServerSettingsPayload } from '@agent-kernel/shared'

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
  versions: {
    host: '0.0.0',
    protocol: '1.0.0',
    build: {
      releaseTag: 'test-release',
      gitCommit: 'abc123',
      builtAt: '2026-07-15T00:00:00.000Z',
      artifactKind: 'cjs',
      dashboardMode: 'embedded',
      embeddedDashboardFiles: 42,
    },
  },
  socketConnections: {
    total: 3,
    dashboard: 2,
    executor: 1,
    other: 0,
    namespaces: [
      { namespace: '/dashboard', sockets: 2, dashboard: 2, executor: 0, other: 0 },
      { namespace: '/executor', sockets: 1, dashboard: 0, executor: 1, other: 0 },
    ],
    updatedAt: '2026-07-20T00:00:00.000Z',
  },
  agentPrompt: {
    selectedPreset: 'codex',
    presets: [
      { id: 'codex', label: 'Codex', description: 'Direct coding-agent prompt.' },
      { id: 'claude-code', label: 'Claude Code', description: 'Concise pair-programming prompt.' },
    ],
    configPath: '<home>/.config/agent-kernel/agent.json',
  },
  paths: {
    claudeSettings: '<home>/.claude/settings.json',
    codexConfig: '<home>/.codex/config.toml',
    manualModels: '<home>/.config/agent-kernel/models.json',
    hooksConfig: '<home>/.config/agent-kernel/config.toml',
    sessionsDir: '<home>/.agent-kernel/sessions',
  },
  mcp: {
    supported: false,
    note: 'MCP runtime is not implemented yet — see docs/host/mcp.md for the planned design.',
  },
  socketAdmin: {
    active: true,
    initialized: true,
    path: '/admin/socket.io',
    username: 'admin',
    runtimeMode: 'production',
    configuredMode: 'production',
    configPath: '<home>/.config/agent-kernel/socket-admin.json',
    distSource: 'embedded',
    createdAt: '2026-07-20T00:00:00.000Z',
  },
}

async function waitForSettingsLoaded(): Promise<void> {
  await screen.findByText('Host endpoint')
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

  it('fetches /settings on open and shows connection settings by default', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings', { cache: 'no-store' })
    })

    await waitForSettingsLoaded()
    expect(screen.getByText('Override host endpoint')).toBeTruthy()
  })

  it('uses a mobile-safe settings shell', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    expect(screen.getByTestId('settings-dialog').className).toContain('h-[calc(var(--ak-viewport-h,100dvh)-0.5rem)]')
    expect(screen.getByTestId('settings-tab-connection').className).toContain('w-32')
  })

  it('shows current Socket.IO connection audit counts in deployment settings', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-deployment'))

    const panel = await screen.findByTestId('settings-socket-connections')
    expect(panel.textContent).toContain('Socket.IO connections')
    expect(panel.textContent).toContain('3 active sockets')
    expect(panel.textContent).toContain('/dashboard: 2 sockets')
    expect(panel.textContent).toContain('/executor: 1 sockets')
  })

  it('switches to Models tab and lists providers + default model', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

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

  it('shows the self-hosted Socket.IO Admin UI endpoint', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-socketAdmin'))

    expect(await screen.findByText('Admin UI endpoint')).toBeTruthy()
    expect(screen.getByText('/admin/socket.io')).toBeTruthy()
    expect(screen.getByText('admin')).toBeTruthy()
    expect(screen.getByText('embedded in host bundle')).toBeTruthy()
  })

  it('initializes the Socket.IO Admin UI password once', async () => {
    const uninitialized: ServerSettingsPayload = {
      ...payload,
      socketAdmin: {
        active: false,
        initialized: false,
        path: '/admin/socket.io',
        username: 'admin',
        runtimeMode: 'development',
        configuredMode: 'development',
        configPath: '<home>/.config/agent-kernel/socket-admin.json',
      },
    }
    const initialized: ServerSettingsPayload = {
      ...payload,
      socketAdmin: { ...payload.socketAdmin!, active: true },
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(uninitialized), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(initialized), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(initialized), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-socketAdmin'))
    fireEvent.change(await screen.findByLabelText('Initial password'), { target: { value: 'secret-password' } })
    fireEvent.change(screen.getByTestId('settings-socket-admin-initial-mode-select'), { target: { value: 'development' } })
    fireEvent.click(screen.getByText('Initialize password'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings/socket-admin/init', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ password: 'secret-password', mode: 'development' }),
      }))
    })
    expect(await screen.findByText('Admin UI endpoint')).toBeTruthy()
    expect(screen.queryByText('Password initialized. Restart the host to enable Socket.IO Admin UI.')).toBeNull()
  })

  it('updates the Socket.IO Admin UI mode', async () => {
    const nextPayload: ServerSettingsPayload = {
      ...payload,
      socketAdmin: { ...payload.socketAdmin!, configuredMode: 'development', restartRequired: true },
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-socketAdmin'))
    fireEvent.change(await screen.findByTestId('settings-socket-admin-mode-select'), { target: { value: 'development' } })
    fireEvent.click(screen.getByTestId('settings-socket-admin-save-mode'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings/socket-admin/mode', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mode: 'development' }),
      }))
    })
    expect(await screen.findByTestId('settings-socket-admin-restart-required')).toBeTruthy()
    expect(screen.getByTestId('settings-socket-admin-restart-required').textContent).toContain('Current host is running production')
    expect(screen.getByTestId('settings-socket-admin-restart-required').textContent).toContain('configured mode is development')
    expect(screen.getByTestId('settings-socket-admin-save-mode')).toBeTruthy()
  })

  it('updates the agent prompt preset', async () => {
    const nextPayload: ServerSettingsPayload = {
      ...payload,
      agentPrompt: payload.agentPrompt ? { ...payload.agentPrompt, selectedPreset: 'claude-code' } : undefined,
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-agent'))
    fireEvent.click(await screen.findByTestId('settings-agent-preset-claude-code'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings/agent-prompt', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ preset: 'claude-code' }),
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('settings-agent-preset-claude-code').getAttribute('aria-pressed')).toBe('true')
    })
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
    await waitForSettingsLoaded()

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
            models: [{ ref: 'openai-compat:gpt-5.5-mini', id: 'gpt-5.5-mini', label: 'GPT 5.5 Mini', provider: p.label, providerId: p.id, source: 'manual', contextWindow: 123456 }],
          }
        : p),
    }
    const onModelsChanged = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} onModelsChanged={onModelsChanged} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-models'))
    fireEvent.change(screen.getByTestId('settings-model-provider-select'), { target: { value: 'openai-compat' } })
    fireEvent.change(screen.getByTestId('settings-model-id-input'), { target: { value: 'gpt-5.5-mini' } })
    fireEvent.change(screen.getByTestId('settings-model-context-window-input'), { target: { value: '123456' } })
    fireEvent.click(screen.getByTestId('settings-model-add-button'))

    await screen.findByText('gpt-5.5-mini')
    expect(screen.getByTestId('settings-provider-openai-compat').textContent).toContain('123,456')
    expect(fetchMock).toHaveBeenCalledWith('/settings/models', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ providerId: 'openai-compat', id: 'gpt-5.5-mini', contextWindow: 123456 }),
    }))
    expect(onModelsChanged).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByLabelText('delete model gpt-5.5-mini'))
    await screen.findByText(/No model attached/)
    expect(fetchMock).toHaveBeenCalledWith('/settings/models?providerId=openai-compat&id=gpt-5.5-mini', { method: 'DELETE' })
    expect(onModelsChanged).toHaveBeenCalledTimes(2)
  })

  it('sets the default model by provider-qualified ref', async () => {
    const modelPayload: ServerSettingsPayload = {
      ...payload,
      providers: payload.providers.map((p) => p.id === 'openai-compat'
        ? { ...p, models: [{ ref: 'openai-compat:gpt-shared', id: 'gpt-shared', label: 'GPT Shared', provider: p.label, providerId: p.id, source: 'manual' }] }
        : p),
    }
    const nextPayload: ServerSettingsPayload = { ...modelPayload, defaultModel: 'openai-compat:gpt-shared' }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(modelPayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(nextPayload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-models'))
    fireEvent.click(await screen.findByRole('button', { name: 'set default model openai-compat:gpt-shared' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/settings/default-model', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'openai-compat:gpt-shared' }),
      }))
    })
    expect(await screen.findByText('default')).toBeTruthy()
  })

  it('adds and deletes manual providers without rendering API keys', async () => {
    const withProvider: ServerSettingsPayload = {
      ...payload,
      providers: [
        ...payload.providers,
        {
          id: 'local-openai',
          label: 'Local OpenAI',
          wire: 'openai',
          source: 'manual',
          baseUrl: 'http://localhost:8000/v1',
          models: [],
        },
      ],
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(withProvider), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-models'))
    fireEvent.change(screen.getByTestId('settings-provider-id-input'), { target: { value: 'local-openai' } })
    fireEvent.change(screen.getByTestId('settings-provider-label-input'), { target: { value: 'Local OpenAI' } })
    fireEvent.change(screen.getByTestId('settings-provider-base-url-input'), { target: { value: 'http://localhost:8000/v1' } })
    fireEvent.change(screen.getByTestId('settings-provider-api-key-input'), { target: { value: 'test-redacted-api-key' } })
    fireEvent.click(screen.getByRole('button', { name: /add provider/i }))

    const provider = await screen.findByTestId('settings-provider-local-openai')
    expect(provider.textContent).toContain('Local OpenAI')
    expect(provider.textContent).toContain('http://localhost:8000/v1')
    expect(screen.queryByText('test-redacted-api-key')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/settings/providers', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        id: 'local-openai',
        label: 'Local OpenAI',
        wire: 'openai',
        baseUrl: 'http://localhost:8000/v1',
        apiKey: 'test-redacted-api-key',
      }),
    }))

    fireEvent.click(screen.getByLabelText('delete provider local-openai'))
    await waitFor(() => {
      expect(screen.queryByTestId('settings-provider-local-openai')).toBeNull()
    })
    expect(fetchMock).toHaveBeenCalledWith('/settings/providers?providerId=local-openai', { method: 'DELETE' })
  })

  it('renders hooks table when hooks are configured', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-hooks'))
    await screen.findByText('/usr/local/bin/lint.sh')
    expect(screen.getByText('/usr/local/bin/log.sh')).toBeTruthy()
    expect(screen.getByText('pre_tool_use')).toBeTruthy()
    expect(screen.getByText('post_tool_use')).toBeTruthy()
  })

  it('flags MCP as not implemented', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-mcp'))
    await screen.findByText('Not implemented yet')
    expect(screen.getAllByText(/docs\/host\/mcp\.md/i).length).toBeGreaterThan(0)
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
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-notifications'))
    await screen.findByText('Browser notifications and local sound for session events that need attention.')
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

  it('keeps notifications as the final settings tab', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    const tabs = screen.getAllByTestId(/^settings-tab-/)
    expect(tabs.at(-1)?.getAttribute('data-testid')).toBe('settings-tab-notifications')
  })

  it('offers follow system as a theme preference', async () => {
    localStorage.setItem('ak-theme', 'dark')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    await screen.findByTestId('settings-theme-toggle')
    expect(screen.getByTestId('settings-theme-system')).toBeTruthy()
    expect(screen.getByTestId('settings-theme-dark').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByTestId('settings-theme-system'))
    expect(screen.getByTestId('settings-theme-system').getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('ak-theme')).toBe('system')

    fireEvent.click(screen.getByTestId('settings-theme-light'))
    expect(localStorage.getItem('ak-theme')).toBe('light')
  })

  it('searches marketplace VS Code themes and stores selected raw theme JSON', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/settings') return new Response(JSON.stringify(payload), { status: 200 })
      if (url.startsWith('/themes/marketplace/search')) {
        return new Response(JSON.stringify({ results: [{ namespace: 'example', name: 'theme', displayName: 'Example Theme', description: 'Theme pack', version: '1.0.0', verified: true, downloadCount: 9 }] }), { status: 200 })
      }
      if (url === '/themes/marketplace/extensions/example/theme') {
        return new Response(JSON.stringify({ namespace: 'example', name: 'theme', displayName: 'Example Theme', description: 'Theme pack', version: '1.0.0', verified: true, downloadCount: 9, themes: [{ id: 'Example Dark', label: 'Example Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }] }), { status: 200 })
      }
      if (url === '/themes/marketplace/extensions/example/theme/themes/Example%20Dark') {
        return new Response(JSON.stringify({ extension: {}, theme: { name: 'Example Dark', type: 'dark', colors: { 'editor.background': '#101010', foreground: '#f0f0f0' } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    })

    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()
    fireEvent.click(screen.getByTestId('settings-tab-interface'))

    const marketplace = await screen.findByTestId('settings-vscode-marketplace')
    expect(marketplace.textContent).toContain('Theme list')
    const defaultThemeRow = await screen.findByTestId('settings-vscode-theme-agent-kernel-dark')
    expect(defaultThemeRow.textContent).toContain('Default Dark')
    expect(defaultThemeRow.textContent).not.toContain('Built in')
    await screen.findByText('Example Theme')
    fireEvent.click(screen.getByText('Example Theme'))
    const themeRow = await screen.findByTestId('settings-vscode-theme-example.theme:Example Dark')
    fireEvent.click(Array.from(themeRow.querySelectorAll('button')).at(0)!)
    await waitFor(() => {
      expect(themeRow.textContent).toContain('Previewing')
    })
    fireEvent.click(Array.from(themeRow.querySelectorAll('button')).at(-1)!)

    await waitFor(() => {
      expect(localStorage.getItem('ak-vscode-theme')).toContain('Example Dark')
    })
  })

  it('stores the live tool activity tail preference', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    await screen.findByTestId('settings-theme-toggle')
    const input = screen.getByTestId('settings-live-tool-activity-tail') as HTMLInputElement
    expect(input.value).toBe('3')

    fireEvent.change(input, { target: { value: '5' } })

    expect(localStorage.getItem('ak-live-tool-activity-tail-count')).toBe('5')
    expect(input.value).toBe('5')
  })

  it('stores the session view cache memory limit preference', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    const input = await screen.findByTestId('settings-session-cache-max-mb') as HTMLInputElement
    expect(input.value).toBe('500')

    fireEvent.change(input, { target: { value: '750' } })

    expect(localStorage.getItem('ak-session-view-cache-max-mb')).toBe('750')
    expect(input.value).toBe('750')
  })

  it('stores chat and file view display preferences locally', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-interface'))
    await screen.findByTestId('settings-chat-font-size')

    fireEvent.click(screen.getByTestId('settings-chat-font-size-6'))
    fireEvent.click(screen.getByTestId('settings-file-view-font-size-4'))
    fireEvent.click(screen.getByTestId('settings-session-explorer-font-size-3'))
    fireEvent.click(screen.getByTestId('settings-file-explorer-font-size-2'))
    fireEvent.click(screen.getByTestId('settings-chat-content-width-2'))
    fireEvent.click(screen.getByTestId('settings-chat-side-space-0'))
    fireEvent.click(screen.getByTestId('settings-chat-line-height-2'))
    fireEvent.click(screen.getByTestId('settings-chat-math-scale-4'))

    expect(localStorage.getItem('ak-chat-font-size')).toBe('6')
    expect(localStorage.getItem('ak-file-view-font-size')).toBe('4')
    expect(localStorage.getItem('ak-session-explorer-font-size')).toBe('3')
    expect(localStorage.getItem('ak-file-explorer-font-size')).toBe('2')
    expect(localStorage.getItem('ak-chat-content-width')).toBe('2')
    expect(localStorage.getItem('ak-chat-side-space')).toBe('0')
    expect(localStorage.getItem('ak-chat-line-height')).toBe('2')
    expect(localStorage.getItem('ak-chat-math-scale')).toBe('4')
  })

  it('keeps desktop notifications disabled when browser permission is denied', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    const NotificationMock = vi.fn()
    Object.assign(NotificationMock, { permission: 'denied', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', NotificationMock)
    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-notifications'))
    await screen.findByText('Browser notifications and local sound for session events that need attention.')
    const toggle = screen.getByTestId('settings-toggle-desktop-notifications') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/Notifications are blocked/i)).toBeTruthy()
  })

  it('renders executor invites with stable ids and binding context', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        invites: [
          {
            id: 'invite-alpha-0001',
            label: 'Connect Workspace',
            createdAt: '2026-07-15T00:00:00.000Z',
            revoked: false,
          },
          {
            id: 'invite-beta-0002',
            label: 'Connect Workspace',
            workspaceId: 'ws-bound',
            createdAt: '2026-07-15T01:00:00.000Z',
            lastUsedAt: '2026-07-15T02:00:00.000Z',
            revoked: false,
          },
        ],
      }), { status: 200 }))

    render(<SettingsDialog open onOpenChange={() => {}} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-executorAccess'))

    await screen.findByTestId('executor-invite-list')
    expect(screen.getAllByTestId('executor-invite-row')).toHaveLength(2)
    expect(screen.getByText('Unbound invite')).toBeTruthy()
    expect(screen.getByText('invite-alpha')).toBeTruthy()
    expect(screen.getByText('invite-beta-')).toBeTruthy()
    expect(screen.getByText('Waiting for the first executor connection')).toBeTruthy()
    expect(screen.getByText('ws-bound')).toBeTruthy()
    expect(screen.queryByDisplayValue('Connect Workspace')).toBeNull()
  })

  it('shows deployment component inventory and executor build metadata', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
    const executors: AttachedExecutor[] = [
      {
        executorId: 'exec-1',
        workspaceId: 'ws-1',
        workspaceName: 'example-executor',
        tools: ['bash'],
        runtime: 'node',
        runtimeVersion: 'v22.22.2',
        clientVersion: '1.0.0',
        executorVersion: '0.0.0',
        capabilities: {
          schemaVersion: 1,
          features: {
            backgroundShell: true,
            filePicker: true,
            overflowFiles: true,
            workspaceSandbox: false,
          },
        },
        hostname: 'example-executor-host',
        pid: 15372,
        build: {
          releaseTag: 'test-release',
          gitCommit: 'def456',
          builtAt: '2026-07-15T00:10:00.000Z',
          artifactKind: 'cjs',
          dashboardMode: 'none',
        },
      },
    ]
    render(<SettingsDialog open onOpenChange={() => {}} executors={executors} />)
    await waitForSettingsLoaded()

    fireEvent.click(screen.getByTestId('settings-tab-deployment'))

    expect(screen.getByText('Component inventory')).toBeTruthy()
    expect(screen.getByText('Host runtime')).toBeTruthy()
    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(screen.getByText('Protocol')).toBeTruthy()
    expect(screen.getByText('Executor: example-executor')).toBeTruthy()
    expect(screen.getByText('Instance')).toBeTruthy()
    expect(screen.getByText('Health')).toBeTruthy()
    expect(screen.getAllByText('abc123').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('embedded in host bundle, 42 files')).toBeTruthy()
    expect(screen.getByText('bundle-dashboard-with-runtime.cjs')).toBeTruthy()
    expect(screen.getByText('agent-kernel-executor.cjs')).toBeTruthy()
    expect(screen.getByText('def456')).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.getByText('embedded in host')).toBeTruthy()
    expect(screen.getByText('example-executor-host | Node.js v22.22.2 | pid 15372')).toBeTruthy()
    expect(screen.getByText('background shell, file picker, overflow files')).toBeTruthy()
  })
})
